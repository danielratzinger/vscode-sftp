import { ancestorsOf, gitIgnoreIn } from '../gitIgnored';

/**
 * A watcher sees every write by every process, so `npm install` in a watched
 * checkout is forty thousand files heading for the server unless git is asked
 * first. What matters here is that git is asked once per directory rather than
 * once per file, and that a failure to reach git never turns into "ignore
 * everything".
 */

/** Stands in for git: these prefixes are ignored, and every call is counted. */
function fakeGit(ignoredPrefixes: string[]) {
  const asked: string[][] = [];

  const ask = async (paths: string[]) => {
    asked.push(paths);
    return paths.filter(one =>
      ignoredPrefixes.some(
        prefix => one === prefix || one.indexOf(`${prefix}/`) === 0
      )
    );
  };

  return { ask, asked };
}

describe('the directories between a root and a file', () => {
  it('is every one of them, outermost first', () => {
    expect(ancestorsOf('/repo', '/repo/a/b/c.ts')).toEqual(['a', 'a/b']);
  });

  it('is nothing for a file sitting in the root', () => {
    expect(ancestorsOf('/repo', '/repo/index.php')).toEqual([]);
  });

  it('is nothing for a path outside the root', () => {
    expect(ancestorsOf('/repo', '/elsewhere/index.php')).toEqual([]);
  });
});

describe('asking git what to leave alone', () => {
  it('ignores what git ignores', async () => {
    const git = fakeGit(['node_modules']);
    const lookup = gitIgnoreIn('/repo', git.ask);

    expect(await lookup.ignored('/repo/node_modules/left-pad/index.js')).toBe(true);
    expect(await lookup.ignored('/repo/src/index.php')).toBe(false);
  });

  it('asks about a directory once, however many files are under it', async () => {
    const git = fakeGit(['node_modules']);
    const lookup = gitIgnoreIn('/repo', git.ask);

    for (let i = 0; i < 500; i += 1) {
      expect(await lookup.ignored(`/repo/node_modules/pkg${i}/index.js`)).toBe(true);
    }

    // The first file is asked about; after that `node_modules` is known, and
    // nothing under it is ever asked about again.
    expect(git.asked).toHaveLength(1);
  });

  it('asks once for a whole batch, not once per file', async () => {
    // The case that matters: a build step writes hundreds of files that are
    // not ignored at all, so no directory answer can short-circuit them.
    const git = fakeGit([]);
    const lookup = gitIgnoreIn('/repo', git.ask);

    const files: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      files.push(`/repo/src/thing${i}.php`);
    }

    expect(await lookup.ignoredAmong(files)).toEqual(new Set());
    expect(git.asked).toHaveLength(1);
    // `src` is asked about once, not four hundred times.
    expect(git.asked[0]).toHaveLength(401);
  });

  it('answers a batch that mixes ignored and deployable files', async () => {
    const git = fakeGit(['node_modules', 'dist']);
    const lookup = gitIgnoreIn('/repo', git.ask);

    const ignored = await lookup.ignoredAmong([
      '/repo/src/index.php',
      '/repo/node_modules/left-pad/index.js',
      '/repo/dist/app.js',
      '/repo/README.md',
    ]);

    expect(ignored).toEqual(
      new Set(['/repo/node_modules/left-pad/index.js', '/repo/dist/app.js'])
    );
  });

  it('does not hold on to an answer after it is told to forget', async () => {
    const git = fakeGit(['dist']);
    const lookup = gitIgnoreIn('/repo', git.ask);

    await lookup.ignored('/repo/dist/app.js');
    lookup.forget();
    await lookup.ignored('/repo/dist/app.js');

    expect(git.asked).toHaveLength(2);
  });

  it('deploys everything when there is no git to ask', async () => {
    // A repository this is not, or git is not installed. Refusing to upload
    // would be the wrong way round: the feature worked without this check
    // before it existed.
    const lookup = gitIgnoreIn('/repo', async () => undefined);

    expect(await lookup.ignored('/repo/node_modules/anything.js')).toBe(false);
  });

  it('stops asking once git has failed', async () => {
    let calls = 0;
    const lookup = gitIgnoreIn('/repo', async () => {
      calls += 1;
      return undefined;
    });

    await lookup.ignored('/repo/a.js');
    await lookup.ignored('/repo/b.js');

    expect(calls).toBe(1);
  });

  it('says nothing about a path outside the checkout', async () => {
    const git = fakeGit(['node_modules']);
    const lookup = gitIgnoreIn('/repo', git.ask);

    expect(await lookup.ignored('/elsewhere/node_modules/x.js')).toBe(false);
    expect(git.asked).toHaveLength(0);
  });

  it('asks about the file itself, not only its directories', async () => {
    const git = fakeGit(['.env']);
    const lookup = gitIgnoreIn('/repo', git.ask);

    expect(await lookup.ignored('/repo/.env')).toBe(true);
  });
});
