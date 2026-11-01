import * as readline from 'readline';
import { Readable } from 'stream';
import { redact, RedactOption, REDACTION_MARKER } from './redaction';
import { ContentSearchOption, Match } from './search';

/**
 * A file too large to hand over whole, read a piece at a time.
 *
 * The size limit protects the context, not the connection: a 67 MB download
 * log cannot be read as one answer, but its last hundred lines can, and so
 * can the lines in it that mention one order. Both are reached without a copy
 * of the whole file - the end by starting the transfer near it, a range or a
 * search by reading from the top and letting go of each line once it has been
 * looked at.
 *
 * Nothing here returns more than the size limit, and every line passes the
 * redaction `read` applies before anything leaves.
 */

/** A stream of the file from a byte offset to its end. */
export type OpenAt = (start: number) => Promise<Readable>;

/** Asked between lines; true ends the read where it is. */
export type ShouldStop = () => boolean;

const FIRST_TAIL_SPAN = 64 * 1024;

const KEY_BEGIN = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
const KEY_END = /-----END (?:[A-Z ]+ )?PRIVATE KEY-----/;
const KEY_LINE = `${REDACTION_MARKER}private-key]`;

/**
 * Redaction a block of lines at a time, keeping every line where it was.
 *
 * `redact` replaces a private key, BEGIN to END, with one marker - fine for a
 * whole file, but a line number after it would then be wrong, and a key cut in
 * two by the edge of a block would match neither half. Keys are taken out
 * here, line by line, with the state carried from one block to the next; what
 * is left goes to `redact` as one text, which is quick, and line by line in
 * the rare block where that changed the number of lines.
 */
export class LineRedactor {
  private inKey = false;
  readonly found = new Set<string>();

  constructor(private readonly option: RedactOption = {}) {}

  /**
   * `midway`: the first block starts somewhere inside the file, so a key's END
   * may come with no BEGIN before it. Everything up to that END is the key.
   */
  lines(raw: string[], midway = false): string[] {
    if (midway) {
      const end = raw.findIndex(line => KEY_END.test(line));
      const begin = raw.findIndex(line => KEY_BEGIN.test(line));
      if (end !== -1 && (begin === -1 || begin > end)) {
        this.found.add('private-key');
        raw = raw.map((line, at) => (at <= end ? KEY_LINE : line));
      }
    }

    const keyless = raw.map(line => {
      if (this.inKey) {
        if (KEY_END.test(line)) {
          this.inKey = false;
        }
        return KEY_LINE;
      }
      if (KEY_BEGIN.test(line)) {
        this.inKey = !KEY_END.test(line);
        this.found.add('private-key');
        return KEY_LINE;
      }
      return line;
    });

    const whole = this.scrub(keyless.join('\n'));
    const split = whole.split('\n');
    if (split.length === keyless.length) {
      return split;
    }

    return keyless.map(line => this.scrub(line));
  }

  private scrub(text: string): string {
    const result = redact(text, this.option);
    result.found.forEach(rule => this.found.add(rule));
    return result.text;
  }
}

/** Everything from `start` to the end, as bytes. */
async function readFrom(open: OpenAt, start: number, cap: number): Promise<Buffer> {
  const stream = await open(start);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) {
        return;
      }
      done = true;
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks));
      }
    };

    stream.on('data', chunk => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(bytes);
      total += bytes.length;
      // A file that grew while it was read is still read only to here.
      if (total >= cap) {
        stream.destroy();
        finish();
      }
    });
    stream.on('error', finish);
    stream.on('end', () => finish());
    stream.on('close', () => finish());
  });
}

export interface Tail {
  lines: string[];
  /** The first line returned is the first line of the file. */
  fromStart: boolean;
  /** Fewer lines than asked for, because they would not fit in the limit. */
  cutShort: boolean;
}

/**
 * The last `count` lines, fetched from near the end.
 *
 * A first look at the last 64 KB, then four times as much until the lines are
 * there, the file runs out, or the limit is reached. A line cut by where the
 * read began is left out, so no line is ever half a line.
 */
export async function tailOf(
  open: OpenAt,
  size: number,
  count: number,
  maxBytes: number
): Promise<Tail> {
  let span = Math.min(size, FIRST_TAIL_SPAN, maxBytes);

  for (;;) {
    const start = size - span;
    const text = (await readFrom(open, start, span)).toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (start > 0) {
      lines.shift();
    }

    const fromStart = start === 0;
    const enough = lines.length >= count;
    if (enough || fromStart || span >= maxBytes) {
      const kept = lines.slice(-count);
      return {
        lines: kept,
        fromStart: fromStart && kept.length === lines.length,
        cutShort: !enough && !fromStart,
      };
    }

    span = Math.min(size, span * 4, maxBytes);
  }
}

/**
 * Each line from the top, until `visit` says to stop, the file ends, or
 * `shouldStop` does. Resolves with whether the end of the file was reached.
 */
export function eachLine(
  stream: Readable,
  visit: (line: string, number: number) => boolean | void,
  shouldStop: ShouldStop = () => false
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let number = 0;
    let settled = false;

    const settle = (atEnd: boolean, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(watch);
      lines.removeAllListeners();
      // readline passes on its input's errors, and an FTP transfer let go of
      // early reports the server's 426 after its reader has finished.
      lines.on('error', () => undefined);
      lines.close();
      if (!atEnd) {
        stream.destroy();
      }
      if (error) {
        reject(error);
      } else {
        resolve(atEnd);
      }
    };

    // A connection that goes quiet sends no lines to check between.
    const watch = setInterval(() => {
      if (shouldStop()) {
        settle(false);
      }
    }, 250);

    lines.on('line', line => {
      if (settled) {
        return;
      }
      number += 1;
      if (visit(line, number) === false || shouldStop()) {
        settle(false);
      }
    });
    lines.on('close', () => settle(true));
    stream.on('error', error => settle(false, error));
  });
}

export interface LineRange {
  /** Numbered as the file has them, 1-based. */
  lines: Array<{ number: number; text: string }>;
  /** Stopped at the limit before the last line asked for. */
  cutShort: boolean;
  /** The file ended inside the range, or before it. */
  endOfFile: boolean;
  /** Time ran out before the range was reached or finished. */
  outOfTime: boolean;
  /** Lines read, which is all of them when `endOfFile`. */
  seen: number;
}

/** Lines `from` to `to` read from the top, keeping only those. */
export async function rangeOf(
  open: OpenAt,
  from: number,
  to: number,
  maxBytes: number,
  shouldStop: ShouldStop
): Promise<LineRange> {
  const lines: Array<{ number: number; text: string }> = [];
  let bytes = 0;
  let cutShort = false;
  let seen = 0;

  const atEnd = await eachLine(
    await open(0),
    (text, number) => {
      seen = number;
      if (number < from) {
        return true;
      }
      bytes += Buffer.byteLength(text, 'utf8') + 1;
      if (bytes > maxBytes) {
        cutShort = true;
        return false;
      }
      lines.push({ number, text });
      return number < to;
    },
    shouldStop
  );

  const finished = atEnd || cutShort || (lines.length > 0 && lines[lines.length - 1].number >= to);
  return { lines, cutShort, endOfFile: atEnd, outOfTime: !finished, seen };
}

export interface Scan {
  matches: Match[];
  /** The whole file was read. */
  complete: boolean;
  /** How far it got. */
  lines: number;
  outOfTime: boolean;
}

const BLOCK_LINES = 1000;

/**
 * A search through the whole file without keeping it: lines are redacted a
 * block at a time, tested, and dropped, except the few kept for context.
 */
export async function scanFor(
  stream: Readable,
  path: string,
  option: ContentSearchOption,
  test: (line: string) => boolean,
  redactor: LineRedactor,
  shouldStop: ShouldStop
): Promise<Scan> {
  const matches: Match[] = [];
  const context = option.context || 0;
  const recent: string[] = [];
  const waiting: Match[] = [];
  let block: string[] = [];
  let firstInBlock = 1;
  let seen = 0;
  let stoppedByTime = false;

  const enough = () => matches.length >= option.maxPerFile && waiting.length === 0;

  const flush = () => {
    const clean = redactor.lines(block);
    clean.forEach((text, at) => {
      const number = firstInBlock + at;

      for (let i = waiting.length - 1; i >= 0; i -= 1) {
        waiting[i].after!.push(text);
        if (waiting[i].after!.length >= context) {
          waiting.splice(i, 1);
        }
      }

      if (matches.length < option.maxPerFile && test(text)) {
        const match: Match = { path, line: number, text };
        if (context > 0) {
          match.before = recent.slice(-context);
          match.after = [];
          waiting.push(match);
        }
        matches.push(match);
      }

      if (context > 0) {
        recent.push(text);
        if (recent.length > context) {
          recent.shift();
        }
      }
    });
    firstInBlock += block.length;
    block = [];
  };

  const atEnd = await eachLine(
    stream,
    (line, number) => {
      seen = number;
      block.push(line);
      if (block.length >= BLOCK_LINES) {
        flush();
        if (enough()) {
          return false;
        }
      }
      return true;
    },
    () => {
      if (shouldStop()) {
        stoppedByTime = true;
        return true;
      }
      return false;
    }
  );

  if (block.length > 0) {
    flush();
  }

  return {
    matches,
    complete: atEnd,
    lines: seen,
    outOfTime: stoppedByTime && !atEnd,
  };
}
