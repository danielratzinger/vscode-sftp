import * as fs from 'fs';
import * as path from 'path';
import { knownConfigKeys } from '../config';

/**
 * `sftp.json` is validated in the editor against the schema in `schema/`, so an
 * option the extension accepts but the schema has never heard of is underlined
 * in red while somebody types it.
 *
 * Six had drifted apart before this test existed, five of them options added
 * here. Nothing announces that kind of gap: the extension works, and only the
 * person editing the file sees the complaint.
 */
const SCHEMA_DIR = path.join(__dirname, '../../../schema');

function everyPropertyIn(file: string): string[] {
  const found: string[] = [];

  const walk = (node: any) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    if (node.properties && typeof node.properties === 'object') {
      found.push(...Object.keys(node.properties));
    }

    Object.keys(node).forEach(key => walk(node[key]));
  };

  walk(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8')));
  return found;
}

describe('the schema the editor checks sftp.json against', () => {
  const known = new Set(
    fs
      .readdirSync(SCHEMA_DIR)
      .filter(name => name.endsWith('.json'))
      .reduce<string[]>((all, name) => all.concat(everyPropertyIn(name)), [])
  );

  it('knows every option the extension accepts', () => {
    const missing = knownConfigKeys().filter(key => !known.has(key));

    expect(missing).toEqual([]);
  });

  it('is reading real files, so an empty answer cannot pass', () => {
    // Guards the test itself: a wrong path would make the check above vacuous.
    expect(known.size).toBeGreaterThan(30);
    expect(knownConfigKeys().length).toBeGreaterThan(20);
  });
});
