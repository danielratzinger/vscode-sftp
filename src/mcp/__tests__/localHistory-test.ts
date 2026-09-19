jest.mock('fs');

import { vol } from 'memfs';
import {
  contentOf,
  describeAge,
  folderNameFor,
  forgetIndex,
  historyRootFrom,
  stringHash,
  versionsFor,
} from '../localHistory';

const ROOT = '/history';
const URI = 'file:///work/site/index.php';

function store(files: { [path: string]: string }) {
  vol.reset();
  vol.fromJSON(files);
  forgetIndex();
}

const entriesFile = (resource: string, entries: any[]) =>
  JSON.stringify({ version: 1, resource, entries });

describe('folderNameFor', () => {
  it('reproduces the name VS Code gives the folder', () => {
    // Taken from a real store rather than from the algorithm: this pair is
    // what the editor actually wrote to disk.
    const real =
      'file:///Users/danielratzinger/Development/Remote/' +
      'forms.volkswagen-nutzfahrzeuge.ch/prospekt/index.php';

    expect(stringHash(real)).toBe(-269693472);
    expect(folderNameFor(real)).toBe('-10133220');
  });
});

describe('historyRootFrom', () => {
  it('finds History beside globalStorage, whatever the build is called', () => {
    expect(
      historyRootFrom('/Users/x/Library/Application Support/Code/User/globalStorage/liximomo.sftp')
    ).toBe('/Users/x/Library/Application Support/Code/User/History');

    expect(
      historyRootFrom('/home/x/.config/VSCodium/User/globalStorage/liximomo.sftp')
    ).toBe('/home/x/.config/VSCodium/User/History');
  });
});

describe('versionsFor', () => {
  it('reads the versions of a file, newest first', async () => {
    const folder = folderNameFor(URI);
    store({
      [`${ROOT}/${folder}/entries.json`]: entriesFile(URI, [
        { id: 'aaaa.php', timestamp: 1000 },
        { id: 'bbbb.php', timestamp: 3000, source: 'undoRedo.source' },
        { id: 'cccc.php', timestamp: 2000 },
      ]),
      [`${ROOT}/${folder}/aaaa.php`]: 'first',
      [`${ROOT}/${folder}/bbbb.php`]: 'third',
      [`${ROOT}/${folder}/cccc.php`]: 'second',
    });

    const versions = await versionsFor(ROOT, URI);

    expect(versions.map(v => v.id)).toEqual(['bbbb.php', 'cccc.php', 'aaaa.php']);
    expect(versions[0].source).toBe('undoRedo.source');
    expect(await contentOf(ROOT, versions[0])).toBe('third');
  });

  it('finds the folder even when the naming scheme does not match', async () => {
    // The name is a guess at somebody else's scheme; the resource inside is
    // the proof, so a changed scheme costs a scan rather than the feature.
    store({
      [`${ROOT}/something-else/entries.json`]: entriesFile(URI, [
        { id: 'aaaa.php', timestamp: 1000 },
      ]),
      [`${ROOT}/something-else/aaaa.php`]: 'found anyway',
    });

    const versions = await versionsFor(ROOT, URI);

    expect(versions).toHaveLength(1);
    expect(await contentOf(ROOT, versions[0])).toBe('found anyway');
  });

  it('refuses a folder whose resource is a different file', async () => {
    // A hash collision must not serve somebody else's file.
    const folder = folderNameFor(URI);
    store({
      [`${ROOT}/${folder}/entries.json`]: entriesFile(
        'file:///work/site/other.php',
        [{ id: 'aaaa.php', timestamp: 1000 }]
      ),
      [`${ROOT}/${folder}/aaaa.php`]: 'not yours',
    });

    expect(await versionsFor(ROOT, URI)).toEqual([]);
  });

  it('says nothing rather than guessing at a format it does not know', async () => {
    const folder = folderNameFor(URI);
    store({
      [`${ROOT}/${folder}/entries.json`]: JSON.stringify({
        version: 2,
        resource: URI,
        entries: [{ id: 'aaaa.php', timestamp: 1000 }],
      }),
    });

    expect(await versionsFor(ROOT, URI)).toEqual([]);
  });

  it('copes with no history at all', async () => {
    store({ '/somewhere/else': '' });

    expect(await versionsFor(ROOT, URI)).toEqual([]);
  });

  it('copes with a broken entries file', async () => {
    const folder = folderNameFor(URI);
    store({ [`${ROOT}/${folder}/entries.json`]: 'not json' });

    expect(await versionsFor(ROOT, URI)).toEqual([]);
  });
});

describe('describeAge', () => {
  const now = 1_700_000_000_000;

  it('says how long ago in words', () => {
    expect(describeAge(now - 30 * 1000, now)).toBe('just now');
    expect(describeAge(now - 10 * 60 * 1000, now)).toBe('10 minutes ago');
    expect(describeAge(now - 5 * 60 * 60 * 1000, now)).toBe('5 hours ago');
    expect(describeAge(now - 3 * 24 * 60 * 60 * 1000, now)).toBe('3 days ago');
  });
});
