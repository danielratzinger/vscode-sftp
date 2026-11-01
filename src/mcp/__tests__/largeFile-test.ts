import { Readable } from 'stream';
import { LineRedactor, OpenAt, rangeOf, scanFor, tailOf } from '../largeFile';
import { lineTest } from '../search';

/** `Readable.from`, which the Node typings here are too old to know. */
function streamOf(pieces: Array<Buffer | string>): Readable {
  const rest = pieces.slice();
  return new Readable({
    read() {
      this.push(rest.length ? rest.shift() : null);
    },
  });
}

/** A file as a server would stream it: from a byte offset, in small chunks. */
function served(text: string, chunk = 7): { open: OpenAt; size: number; read: number[] } {
  const bytes = Buffer.from(text, 'utf8');
  const read: number[] = [];
  return {
    size: bytes.length,
    read,
    open: async start => {
      read.push(start);
      const pieces: Buffer[] = [];
      for (let at = start; at < bytes.length; at += chunk) {
        pieces.push(bytes.slice(at, Math.min(bytes.length, at + chunk)));
      }
      return streamOf(pieces);
    },
  };
}

const numbered = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

describe('the end of a file', () => {
  it('is the last lines, whole, with or without a final newline', async () => {
    const withNewline = served(numbered(10));
    expect((await tailOf(withNewline.open, withNewline.size, 2, 1024)).lines).toEqual([
      'line 9',
      'line 10',
    ]);

    const without = served('a\nb\nc');
    expect((await tailOf(without.open, without.size, 2, 1024)).lines).toEqual(['b', 'c']);
  });

  it('reads further back until it has the lines, and no further than the limit', async () => {
    const file = served(numbered(100000));
    const got = await tailOf(file.open, file.size, 20000, 200 * 1024);

    expect(got.lines.length).toBeLessThan(20000);
    expect(got.cutShort).toBe(true);
    expect(got.lines[got.lines.length - 1]).toBe('line 100000');
    // Never the first line of a read that began mid-line.
    expect(got.lines[0]).toMatch(/^line \d+$/);
    expect(file.read.every(start => start > 0)).toBe(true);
  });

  it('says so when it reached the top of a short file', async () => {
    const file = served(numbered(3));
    const got = await tailOf(file.open, file.size, 10, 1024);

    expect(got.lines).toEqual(['line 1', 'line 2', 'line 3']);
    expect(got.fromStart).toBe(true);
    expect(got.cutShort).toBe(false);
  });

  it('keeps a character that a chunk boundary splits', async () => {
    const file = served('üöä\nüöä\n', 1);
    expect((await tailOf(file.open, file.size, 2, 1024)).lines).toEqual(['üöä', 'üöä']);
  });
});

describe('a range of lines', () => {
  it('is numbered as the file has it, CRLF or not', async () => {
    const file = served('one\r\ntwo\r\nthree\r\nfour\r\n');
    const got = await rangeOf(file.open, 2, 3, 1024, () => false);

    expect(got.lines).toEqual([
      { number: 2, text: 'two' },
      { number: 3, text: 'three' },
    ]);
    expect(got.outOfTime).toBe(false);
  });

  it('stops at the limit', async () => {
    const file = served(numbered(1000));
    const got = await rangeOf(file.open, 1, Infinity, 100, () => false);

    expect(got.cutShort).toBe(true);
    expect(got.lines.map(line => line.text).join('\n').length).toBeLessThanOrEqual(100);
  });

  it('knows how long the file is when the range starts past its end', async () => {
    const file = served(numbered(5));
    const got = await rangeOf(file.open, 50, 60, 1024, () => false);

    expect(got.lines).toEqual([]);
    expect(got.endOfFile).toBe(true);
    expect(got.seen).toBe(5);
  });

  it('gives up when time does', async () => {
    const file = served(numbered(1000));
    const got = await rangeOf(file.open, 900, 910, 1024 * 1024, () => true);

    expect(got.lines).toEqual([]);
    expect(got.outOfTime).toBe(true);
  });
});

describe('redacting a block at a time', () => {
  it('keeps every line where it was, whatever is taken out', () => {
    const redactor = new LineRedactor();
    const out = redactor.lines([
      'a',
      "define('DB_PASSWORD', 'Xk7mQ2vL9pR');",
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0B',
      '-----END PRIVATE KEY-----',
      'z',
    ]);

    expect(out).toHaveLength(6);
    expect(out[0]).toBe('a');
    expect(out[5]).toBe('z');
    expect(out.join('\n')).not.toMatch(/Xk7mQ2vL9pR|MIIEvQ/);
    expect(Array.from(redactor.found).sort()).toEqual(['assigned-secret', 'private-key']);
  });

  it('follows a key from one block into the next', () => {
    const redactor = new LineRedactor();
    redactor.lines(['before', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEvQIBADANBgkq']);
    const next = redactor.lines(['hkiG9w0BAQEFAASC', '-----END RSA PRIVATE KEY-----', 'after']);

    expect(next[0]).not.toMatch(/hkiG9w0B/);
    expect(next[2]).toBe('after');
  });

  it('hides the rest of a key it meets halfway through', () => {
    const redactor = new LineRedactor();
    const out = redactor.lines(['hkiG9w0BAQEFAASC', '-----END PRIVATE KEY-----', 'after'], true);

    expect(out[0]).not.toMatch(/hkiG9w0B/);
    expect(out[2]).toBe('after');
  });
});

describe('searching a file without keeping it', () => {
  const option = { query: 'needle', maxMatches: 30, maxPerFile: 3, context: 1 };

  it('finds lines past the first block, with context from the block before', async () => {
    const text = numbered(2500).replace('line 1000\n', 'line 1000 needle\n');
    const scan = await scanFor(
      streamOf([text]),
      '/log',
      option,
      lineTest(option),
      new LineRedactor(),
      () => false
    );

    expect(scan.matches).toEqual([
      { path: '/log', line: 1000, text: 'line 1000 needle', before: ['line 999'], after: ['line 1001'] },
    ]);
    expect(scan.complete).toBe(true);
    expect(scan.lines).toBe(2500);
  });

  it('does not find what redaction hides', async () => {
    const text = "x\ndefine('DB_PASSWORD', 'needle7mQ2vL9pR');\n";
    const scan = await scanFor(
      streamOf([text]),
      '/log',
      option,
      lineTest(option),
      new LineRedactor(),
      () => false
    );

    expect(scan.matches).toEqual([]);
  });

  it('stops once it has max_per_file, rather than reading the rest', async () => {
    const text = Array.from({ length: 5000 }, () => 'needle').join('\n');
    const scan = await scanFor(
      streamOf([text]),
      '/log',
      { ...option, context: 0 },
      lineTest(option),
      new LineRedactor(),
      () => false
    );

    expect(scan.matches).toHaveLength(3);
    expect(scan.complete).toBe(false);
    expect(scan.lines).toBeLessThan(5000);
  });
});
