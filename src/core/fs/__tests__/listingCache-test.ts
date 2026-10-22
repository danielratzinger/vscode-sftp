import ListingCache from '../listingCache';
import { FileType } from '../fileSystem';
import { offersMlst, parseMlst } from '../mlst';

const missing = () => Object.assign(new Error('The system cannot find the path specified.'), { code: 550 });
const isMissing = (error: any) => error && error.code === 550;

describe('a listing remembered for a moment', () => {
  it('lists a folder once for everything asked of it in that moment', async () => {
    let reads = 0;
    const cache = new ListingCache<string>(isMissing);
    const read = async () => {
      reads += 1;
      return ['a.php', 'b.php'];
    };

    await cache.list('/site/tests', read);
    await cache.list('/site/tests/', read);
    await cache.list('/site/tests', read);

    expect(reads).toBe(1);
  });

  // Six files in one folder, asked about at once, as autosync does.
  it('shares one listing between those asking at the same time', async () => {
    let reads = 0;
    const cache = new ListingCache<string>(isMissing);
    const read = () => {
      reads += 1;
      return new Promise<string[]>(resolve => setTimeout(() => resolve(['a']), 10));
    };

    await Promise.all([1, 2, 3, 4, 5, 6].map(() => cache.list('/site/tests', read)));

    expect(reads).toBe(1);
  });

  // An empty server: every folder is missing, and that answer is worth keeping too.
  it('remembers that a folder is not there', async () => {
    let reads = 0;
    const cache = new ListingCache<string>(isMissing);
    const read = async (): Promise<string[]> => {
      reads += 1;
      throw missing();
    };

    await expect(cache.list('/site/new', read)).rejects.toThrow('cannot find');
    await expect(cache.list('/site/new', read)).rejects.toThrow('cannot find');
    expect(reads).toBe(1);
  });

  it('does not remember any other failure', async () => {
    let reads = 0;
    const cache = new ListingCache<string>(isMissing);
    const read = async (): Promise<string[]> => {
      reads += 1;
      throw new Error('connection reset');
    };

    await expect(cache.list('/site', read)).rejects.toThrow();
    await expect(cache.list('/site', read)).rejects.toThrow();
    expect(reads).toBe(2);
  });

  it('reads again once the moment has passed', async () => {
    let now = 0;
    let reads = 0;
    const cache = new ListingCache<string>(isMissing, () => now, 3000);
    const read = async () => {
      reads += 1;
      return ['a'];
    };

    await cache.list('/site', read);
    now = 3001;
    await cache.list('/site', read);

    expect(reads).toBe(2);
  });

  // What this file system writes, it forgets at once: the folder it went into,
  // and a missing folder now created along with everything under it.
  it('forgets the folder a write went into, and what it created', async () => {
    let reads = 0;
    const cache = new ListingCache<string>(isMissing);
    const listed = async () => {
      reads += 1;
      return ['a'];
    };
    const gone = async (): Promise<string[]> => {
      reads += 1;
      throw missing();
    };

    await cache.list('/site/tests', listed);
    await cache.list('/site/new', gone).catch(() => undefined);
    await cache.list('/site/new/deeper', gone).catch(() => undefined);
    await cache.list('/site/other', listed);

    cache.forget('/site/tests/c.php');
    cache.forget('/site/new');

    await cache.list('/site/tests', listed);
    await cache.list('/site/new', listed);
    await cache.list('/site/new/deeper', listed);
    await cache.list('/site/other', listed);

    expect(reads).toBe(4 + 3);
  });

  it('does not keep a listing that was in flight when something was written', async () => {
    let reads = 0;
    const cache = new ListingCache<string>(isMissing);
    let finish: (value: string[]) => void = () => undefined;
    const slow = () => {
      reads += 1;
      return new Promise<string[]>(resolve => (finish = resolve));
    };

    const first = cache.list('/site', slow);
    cache.forget('/site/a.php');
    finish(['old']);
    await first;
    await cache.list('/site', async () => {
      reads += 1;
      return ['new'];
    });

    expect(reads).toBe(2);
  });

  it('hands out copies', async () => {
    const cache = new ListingCache<string>(isMissing);
    const first = await cache.list('/site', async () => ['a']);
    first.push('changed');

    expect(await cache.list('/site', async () => ['b'])).toEqual(['a']);
  });
});

describe('knowing a path is not there without asking', () => {
  type Entry = { name: string; dir: boolean };
  const nameOf = (one: Entry) => one.name;
  const isFolder = (one: Entry) => one.dir;

  // Azure's wwwroot held one file; every folder under it was asked about.
  it('reads an empty folder above as the absence of everything below it', async () => {
    const cache = new ListingCache<Entry>(isMissing);
    await cache.list('/site/wwwroot', async () => [{ name: 'hostingstart.html', dir: false }]);

    expect(cache.knownAbsent('/site/wwwroot/includes/php/a.php', nameOf, isFolder)).toBe(true);
    expect(cache.knownAbsent('/site/wwwroot/tests/Unit/b.php', nameOf, isFolder)).toBe(true);
  });

  it('reads a folder known missing as the absence of everything below it', async () => {
    const cache = new ListingCache<Entry>(isMissing);
    await cache.list('/site/wwwroot/vendor', async () => {
      throw missing();
    }).catch(() => undefined);

    expect(cache.knownAbsent('/site/wwwroot/vendor/psr/simple-cache/src/x.php', nameOf, isFolder)).toBe(true);
  });

  it('does not claim what it does not know', async () => {
    const cache = new ListingCache<Entry>(isMissing);
    await cache.list('/site', async () => [{ name: 'wwwroot', dir: true }]);

    // wwwroot is there, and nothing is known about what is in it.
    expect(cache.knownAbsent('/site/wwwroot/a.php', nameOf, isFolder)).toBe(false);
    expect(cache.knownAbsent('/other/a.php', nameOf, isFolder)).toBe(false);
  });

  it('knows a file listed in its folder is there, and one not listed is not', async () => {
    const cache = new ListingCache<Entry>(isMissing);
    await cache.list('/app', async () => [{ name: 'a.php', dir: false }]);

    expect(cache.knownAbsent('/app/a.php', nameOf, isFolder)).toBe(false);
    expect(cache.knownAbsent('/app/b.php', nameOf, isFolder)).toBe(true);
  });

  // A file cannot have anything under it.
  it('knows nothing is under a file', async () => {
    const cache = new ListingCache<Entry>(isMissing);
    await cache.list('/app', async () => [{ name: 'config', dir: false }]);

    expect(cache.knownAbsent('/app/config/x.php', nameOf, isFolder)).toBe(true);
  });

  it('forgets it once something is written there', async () => {
    const cache = new ListingCache<Entry>(isMissing);
    await cache.list('/site/wwwroot', async () => []);
    cache.forget('/site/wwwroot/includes');

    expect(cache.knownAbsent('/site/wwwroot/includes/a.php', nameOf, isFolder)).toBe(false);
  });
});

describe('MLST', () => {
  it('reads a file’s facts from the reply', () => {
    const facts = parseMlst(
      'Listing /site/wwwroot/a.php\r\n type=file;size=1234;modify=20261022043327; /site/wwwroot/a.php\r\nEnd'
    )!;

    expect(facts.type).toBe(FileType.File);
    expect(facts.size).toBe(1234);
    expect(facts.mtime).toBe(Date.UTC(2026, 9, 22, 4, 33, 27));
  });

  it('knows a folder, and a name with a semicolon in it', () => {
    expect(parseMlst(' type=dir;modify=20261022043327; /site/a;b')!.type).toBe(FileType.Directory);
    expect(parseMlst(' type=file;size=5;modify=20261022043327.123; /a;b.php')!.mtime).toBe(
      Date.UTC(2026, 9, 22, 4, 33, 27, 123)
    );
  });

  it('is nothing when the reply has no facts', () => {
    expect(parseMlst('End')).toBeUndefined();
  });

  it('is offered when FEAT says so', () => {
    expect(offersMlst(['MDTM', 'MLST type*;size*;modify*;', 'SIZE'])).toBe(true);
    expect(offersMlst(['MDTM', 'SIZE'])).toBe(false);
    expect(offersMlst(undefined)).toBe(false);
  });
});
