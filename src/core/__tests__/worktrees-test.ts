jest.mock('fs');

import { vol } from 'memfs';
import {
  describeWorktree,
  gitDirOf,
  worktreeRegistryOf,
  worktreesOf,
} from '../worktrees';

/**
 * The layout is git's own, and the fixtures below are a transcription of a
 * real repository with two agent checkouts in it - including the part that
 * catches people out, where the folder git files a worktree under is not the
 * branch that worktree is on.
 */
const REPO = '/work/site';
const AGENT_ONE = '/elsewhere/workspaces/detailled-integrate/portal';
const AGENT_TWO = '/elsewhere/workspaces/out-check/portal';

function repository() {
  vol.fromJSON({
    [`${REPO}/.git/HEAD`]: 'ref: refs/heads/feature/permissions\n',
    [`${REPO}/index.php`]: '<?php',
    // Named after the last segment of its path, not after its branch.
    [`${REPO}/.git/worktrees/detailled-integrate/gitdir`]: `${AGENT_ONE}/.git\n`,
    [`${REPO}/.git/worktrees/detailled-integrate/HEAD`]: 'ref: refs/heads/detailled-integrate\n',
    [`${REPO}/.git/worktrees/detailled-integrate/commondir`]: '../..\n',
    [`${REPO}/.git/worktrees/portal/gitdir`]: `${AGENT_TWO}/.git\n`,
    [`${REPO}/.git/worktrees/portal/HEAD`]: 'ref: refs/heads/marketing-website\n',
    [`${REPO}/.git/worktrees/portal/commondir`]: '../..\n',
    [`${AGENT_ONE}/.git`]: `gitdir: ${REPO}/.git/worktrees/detailled-integrate\n`,
    [`${AGENT_ONE}/index.php`]: '<?php',
    [`${AGENT_TWO}/.git`]: `gitdir: ${REPO}/.git/worktrees/portal\n`,
    [`${AGENT_TWO}/index.php`]: '<?php',
  });
}

beforeEach(() => vol.reset());

describe('finding the repository', () => {
  it('finds it from the folder itself, and from below', async () => {
    repository();
    vol.mkdirSync(`${REPO}/app/views`, { recursive: true } as any);

    expect(await gitDirOf(REPO)).toBe(`${REPO}/.git`);
    expect(await gitDirOf(`${REPO}/app/views`)).toBe(`${REPO}/.git`);
  });

  it('finds it from inside a linked checkout, where .git is a file', async () => {
    repository();

    expect(await gitDirOf(AGENT_ONE)).toBe(`${REPO}/.git`);
  });

  it('says nothing for a folder in no repository at all', async () => {
    vol.fromJSON({ '/somewhere/else/index.php': '<?php' });

    expect(await gitDirOf('/somewhere/else')).toBeUndefined();
  });
});

describe('listing the worktrees', () => {
  it('lists the repository and every checkout of it', async () => {
    repository();

    const found = await worktreesOf(REPO);

    expect(found.map(w => w.root)).toEqual([REPO, AGENT_ONE, AGENT_TWO]);
    expect(found.map(w => w.branch)).toEqual([
      'feature/permissions',
      'detailled-integrate',
      'marketing-website',
    ]);
    expect(found.filter(w => w.isMain).map(w => w.root)).toEqual([REPO]);
  });

  it('reads the branch rather than the folder it is filed under', async () => {
    // The trap: `.git/worktrees/portal` is on `marketing-website`, and two
    // agents both working in a folder called `portal` give `portal` and
    // `portal1`.
    repository();

    const portal = (await worktreesOf(REPO)).find(w => w.name === 'portal')!;

    expect(portal.branch).toBe('marketing-website');
  });

  it('gives the same answer asked from a linked checkout', async () => {
    repository();

    const fromAgent = await worktreesOf(AGENT_TWO);

    expect(fromAgent.map(w => w.root)).toEqual([REPO, AGENT_ONE, AGENT_TWO]);
  });

  it('marks an entry whose checkout somebody deleted by hand', async () => {
    repository();
    // The agent removed its folder without telling git.
    vol.unlinkSync(`${AGENT_ONE}/.git`);
    vol.unlinkSync(`${AGENT_ONE}/index.php`);
    vol.rmdirSync(AGENT_ONE);

    const found = await worktreesOf(REPO);

    expect(found.find(w => w.root === AGENT_ONE)!.exists).toBe(false);
    expect(found.find(w => w.root === AGENT_TWO)!.exists).toBe(true);
  });

  it('handles a checkout that is on a commit rather than a branch', async () => {
    repository();
    vol.writeFileSync(
      `${REPO}/.git/worktrees/portal/HEAD`,
      'dc48fd792eb52b72564fd1558643eca0961debf8\n'
    );

    const portal = (await worktreesOf(REPO)).find(w => w.name === 'portal')!;

    expect(portal.branch).toBeUndefined();
    expect(describeWorktree(portal)).toContain('detached');
  });

  it('is just the repository when nothing else is checked out', async () => {
    vol.fromJSON({
      [`${REPO}/.git/HEAD`]: 'ref: refs/heads/develop\n',
      [`${REPO}/index.php`]: '<?php',
    });

    const found = await worktreesOf(REPO);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ root: REPO, branch: 'develop', isMain: true });
  });

  it('is nothing at all outside a repository', async () => {
    vol.fromJSON({ '/somewhere/else/index.php': '<?php' });

    expect(await worktreesOf('/somewhere/else')).toEqual([]);
  });
});

describe('where to watch for one appearing', () => {
  it('is the folder git files them under', async () => {
    repository();

    expect(await worktreeRegistryOf(REPO)).toBe(`${REPO}/.git/worktrees`);
    expect(await worktreeRegistryOf(AGENT_ONE)).toBe(`${REPO}/.git/worktrees`);
    expect(await worktreeRegistryOf('/somewhere/else')).toBeUndefined();
  });
});
