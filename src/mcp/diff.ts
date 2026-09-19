/**
 * A unified diff, computed here rather than pulled in.
 *
 * What a model needs from a comparison is the changed lines with a little
 * context, in the format every model has read a million times. That is a
 * couple of hundred lines of code, against a dependency in an extension that
 * ships to other people's machines.
 *
 * The cost of an exact diff is the product of the two lengths, which is fine
 * for source files and not fine for a pair of generated ones. Common prefixes
 * and suffixes are trimmed first - the usual case is a small edit in a large
 * file, and trimming leaves almost nothing to compare - and anything still too
 * large after that is summarised instead of being computed. A summary is worth
 * more than a tool that stops responding.
 */

const CONTEXT = 3;
const MAX_CELLS = 4_000_000;

export interface DiffResult {
  text: string;
  /** False when the files are identical. */
  changed: boolean;
  added: number;
  removed: number;
  /** True when the comparison was too large to compute exactly. */
  summarised: boolean;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');

  // A trailing newline is not a line; keeping it produces a phantom change.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

interface Edit {
  kind: ' ' | '-' | '+';
  text: string;
}

/** Longest common subsequence, the textbook table, on the trimmed middle. */
function editsFor(left: string[], right: string[]): Edit[] {
  const rows = left.length;
  const columns = right.length;
  const table: number[][] = [];

  for (let row = 0; row <= rows; row += 1) {
    table.push(new Array(columns + 1).fill(0));
  }

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row][column] =
        left[row] === right[column]
          ? table[row + 1][column + 1] + 1
          : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }

  const edits: Edit[] = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      edits.push({ kind: ' ', text: left[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      edits.push({ kind: '-', text: left[i] });
      i += 1;
    } else {
      edits.push({ kind: '+', text: right[j] });
      j += 1;
    }
  }

  while (i < rows) {
    edits.push({ kind: '-', text: left[i] });
    i += 1;
  }
  while (j < columns) {
    edits.push({ kind: '+', text: right[j] });
    j += 1;
  }

  return edits;
}

interface Hunk {
  leftStart: number;
  rightStart: number;
  lines: Edit[];
}

/** Only the changed parts, with a few lines either side for orientation. */
function hunksOf(edits: Edit[], leftOffset: number, rightOffset: number): Hunk[] {
  const interesting: boolean[] = edits.map(edit => edit.kind !== ' ');
  const keep: boolean[] = edits.map(() => false);

  interesting.forEach((isChange, at) => {
    if (!isChange) {
      return;
    }
    for (let i = Math.max(0, at - CONTEXT); i <= Math.min(edits.length - 1, at + CONTEXT); i += 1) {
      keep[i] = true;
    }
  });

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let leftLine = leftOffset + 1;
  let rightLine = rightOffset + 1;

  edits.forEach((edit, at) => {
    if (keep[at]) {
      if (!current) {
        current = { leftStart: leftLine, rightStart: rightLine, lines: [] };
      }
      current.lines.push(edit);
    } else if (current) {
      hunks.push(current);
      current = null;
    }

    if (edit.kind !== '+') {
      leftLine += 1;
    }
    if (edit.kind !== '-') {
      rightLine += 1;
    }
  });

  if (current) {
    hunks.push(current);
  }

  return hunks;
}

function render(hunks: Hunk[]): string {
  const out: string[] = [];

  hunks.forEach(hunk => {
    const leftCount = hunk.lines.filter(line => line.kind !== '+').length;
    const rightCount = hunk.lines.filter(line => line.kind !== '-').length;

    out.push(
      `@@ -${hunk.leftStart},${leftCount} +${hunk.rightStart},${rightCount} @@`
    );
    hunk.lines.forEach(line => out.push(`${line.kind}${line.text}`));
  });

  return out.join('\n');
}

export function diff(leftText: string, rightText: string): DiffResult {
  const left = splitLines(leftText);
  const right = splitLines(rightText);

  // Trim what is the same at both ends. The usual comparison is a small edit
  // in a large file, and this leaves almost nothing to compute.
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) {
    head += 1;
  }

  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1;
  }

  const leftMiddle = left.slice(head, left.length - tail);
  const rightMiddle = right.slice(head, right.length - tail);

  if (leftMiddle.length === 0 && rightMiddle.length === 0) {
    return { text: '', changed: false, added: 0, removed: 0, summarised: false };
  }

  if ((leftMiddle.length + 1) * (rightMiddle.length + 1) > MAX_CELLS) {
    return {
      text:
        `The changed part is too large to compare line by line ` +
        `(${leftMiddle.length} lines against ${rightMiddle.length}). ` +
        'Compare a range of it instead.',
      changed: true,
      added: rightMiddle.length,
      removed: leftMiddle.length,
      summarised: true,
    };
  }

  // The trimmed ends are identical, so a few lines of them are exactly the
  // context a reader needs either side of the change.
  const before = Math.min(head, CONTEXT);
  const after = Math.min(tail, CONTEXT);
  const asContext = (lines: string[]): Edit[] =>
    lines.map(text => ({ kind: ' ' as ' ', text }));

  const edits = ([] as Edit[]).concat(
    asContext(left.slice(head - before, head)),
    editsFor(leftMiddle, rightMiddle),
    asContext(left.slice(left.length - tail, left.length - tail + after))
  );

  return {
    text: render(hunksOf(edits, head - before, head - before)),
    changed: true,
    added: edits.filter(edit => edit.kind === '+').length,
    removed: edits.filter(edit => edit.kind === '-').length,
    summarised: false,
  };
}
