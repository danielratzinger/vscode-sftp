/**
 * The names in a file that is otherwise entirely a credential.
 *
 * `.env` and its relatives are refused outright, and that is the one layer of
 * this with no way to be wrong. But the refusal takes something useful with
 * it: which settings a project expects is not a secret, and an agent that
 * cannot see `STRIPE_SECRET_KEY` exists cannot tell you the deploy is missing
 * it. The names are the map; the values are the territory.
 *
 * So a denied file can be served as its names, under one rule that makes the
 * whole thing safe: **no character of any value is ever emitted**. Not the
 * ones that look harmless, not the empty ones - nothing. That removes every
 * judgement about which values are safe to show, and leaves a mistake in the
 * parser able to mis-name a setting but never to leak one.
 *
 * Only formats whose names can be separated from their values with certainty
 * get an outline. Anything else is refused exactly as before, because a
 * best-effort parse of a credential file is the wrong kind of best effort.
 */

/** What stands in for every value. Deliberately not a reversible marker. */
export const WITHHELD = '[value withheld]';

export interface Outline {
  format: 'dotenv' | 'json';
  /** The file as names, with every value replaced. */
  text: string;
  names: string[];
  /** Lines dropped whole, because a comment can hold a value too. */
  omitted: number;
}

const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;

function dotenv(text: string): Outline | undefined {
  const names: string[] = [];
  const lines: string[] = [];
  let omitted = 0;
  let seen = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }

    const match = line.match(DOTENV_LINE);
    if (!match) {
      // A comment, or something this does not understand. Either can carry a
      // value - `# old key: abc123` is a real line in real files.
      omitted += 1;
      continue;
    }

    seen += 1;
    names.push(match[1]);
    lines.push(`${match[1]}=${WITHHELD}`);
  }

  // Nothing recognisable means this is not the format it was taken for, and
  // guessing further is how a credential file gets served by accident.
  if (seen === 0) {
    return undefined;
  }

  return { format: 'dotenv', text: lines.join('\n').trim(), names, omitted };
}

function outlineValue(value: any, names: string[], indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const inner = value
      .map(item => `${indent}  ${outlineValue(item, names, `${indent}  `)}`)
      .join(',\n');
    return `[\n${inner}\n${indent}]`;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return '{}';
    }
    const inner = keys
      .map(key => {
        names.push(key);
        return `${indent}  ${JSON.stringify(key)}: ${outlineValue(
          value[key],
          names,
          `${indent}  `
        )}`;
      })
      .join(',\n');
    return `{\n${inner}\n${indent}}`;
  }

  // Every leaf, whatever it is. A boolean or a number is not obviously a
  // secret, and "not obviously" is the judgement this avoids making.
  return JSON.stringify(WITHHELD);
}

function json(text: string): Outline | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const names: string[] = [];
  return {
    format: 'json',
    text: outlineValue(parsed, names, ''),
    names,
    omitted: 0,
  };
}

function basenameOf(fsPath: string): string {
  const parts = fsPath.split(/[\\/]+/);
  return (parts[parts.length - 1] || '').toLowerCase();
}

/**
 * The names in a denied file, or nothing when they cannot be told apart from
 * the values with certainty.
 */
export function outlineOf(fsPath: string, text: string): Outline | undefined {
  const name = basenameOf(fsPath);

  if (name === '.env' || name.indexOf('.env.') === 0 || name.endsWith('.env')) {
    return dotenv(text);
  }

  if (name.endsWith('.json')) {
    return json(text);
  }

  // A key file has no names in it, and `.htpasswd` and `.netrc` carry account
  // names that are half of a credential. Both stay refused.
  return undefined;
}

export function describeOutline(fsPath: string, outline: Outline): string {
  return (
    `${fsPath} holds credentials, so its contents are withheld. These are the ` +
    `names in it and nothing else: every value is \`${WITHHELD}\`, including ` +
    'the ones that might have been harmless. Nothing was written to this ' +
    'machine.' +
    (outline.omitted > 0
      ? `\n${outline.omitted} line${outline.omitted === 1 ? '' : 's'} ` +
        'left out whole, being comments or shapes this does not parse - a ' +
        'comment can hold a value too.'
      : '')
  );
}
