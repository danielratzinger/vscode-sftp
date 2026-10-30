import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import GitIgnore from 'ignore';
import { AskGit, outside, viaGit } from './gitIgnored';

/**
 * What a project says is not to be deployed: its `.gitignore` files, a
 * `.git-ftp-ignore` beside them, and the repository itself.
 *
 * `.gitignore` is asked of git wherever there is a repository, as autosync
 * asks it, so a tracked file is never called ignored and nested files,
 * `info/exclude` and the global excludes all count. A folder that has the
 * files and no repository - a project downloaded from the server, say - has
 * them read here instead, each applying below the folder it sits in.
 *
 * `.git-ftp-ignore` is git-ftp's: patterns in the `.gitignore` style, one per
 * line, relative to the top of the project. It is read here either way.
 *
 * The connection's own `ignore` and `ignoreFile` are not part of this. They
 * apply to every transfer already, and say "never", where these say "not
 * usually" - which is why the full upload still leaves those out.
 */

export const GIT_FTP_IGNORE = '.git-ftp-ignore';

export interface Candidate {
  /** Absolute, on this machine - where the file is, or would be. */
  path: string;
  dir: boolean;
}

export interface IgnoreRules {
  /** The files the rules come from, relative to the project, for messages. */
  sources: string[];
  /** Which of these the rules leave out. */
  ignoredAmong(candidates: Candidate[]): Promise<Set<string>>;
}

/** Where the repository holding a folder starts, or undefined outside one. */
export type FindRepo = (folder: string) => Promise<string | undefined>;

export const repoOf: FindRepo = folder =>
  new Promise(resolve => {
    execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: folder },
      (error, stdout) => resolve(error ? undefined : path.resolve(stdout.trim()))
    );
  });

function readOrUndefined(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    return undefined;
  }
}

/** Forward slashes, as `ignore` wants them, and a trailing one for a folder. */
function asPattern(relative: string, dir: boolean): string {
  const slashed = relative.split(path.sep).join('/');
  return dir ? `${slashed}/` : slashed;
}

/**
 * A `.gitignore` line from a folder below the top, rewritten to apply from
 * the top, which is how git reads it: anchored when it has a slash before its
 * end, anywhere below its folder when it has not.
 */
function fromTop(line: string, folder: string): string | undefined {
  let pattern = line.replace(/\s+$/, '');
  if (pattern === '' || pattern[0] === '#') {
    return undefined;
  }
  if (folder === '') {
    return pattern;
  }

  let negate = '';
  if (pattern[0] === '!') {
    negate = '!';
    pattern = pattern.slice(1);
  }

  const anchored = pattern.replace(/\/$/, '').indexOf('/') !== -1;
  pattern = pattern.replace(/^\//, '');

  return `${negate}${folder}/${anchored ? '' : '**/'}${pattern}`;
}

/**
 * The `.gitignore` files of a folder with no repository, each read once and
 * only when something below it is asked about.
 */
function readGitignores(top: string) {
  const own = new Map<string, string[]>();
  const combined = new Map<string, any>();

  function linesIn(folder: string): string[] {
    if (!own.has(folder)) {
      const text = readOrUndefined(path.join(top, folder, '.gitignore'));
      own.set(
        folder,
        text === undefined
          ? []
          : text
              .split(/\r?\n/)
              .map(line => fromTop(line, folder.split(path.sep).join('/')))
              .filter((one): one is string => one !== undefined)
      );
    }
    return own.get(folder)!;
  }

  /** Every rule that applies in a folder: its own and those above, top first. */
  function rulesFor(folder: string) {
    if (!combined.has(folder)) {
      const parts = folder === '' ? [] : folder.split(path.sep);
      const lines: string[] = [];
      for (let depth = 0; depth <= parts.length; depth += 1) {
        lines.push(...linesIn(parts.slice(0, depth).join(path.sep)));
      }
      combined.set(folder, GitIgnore().add(lines));
    }
    return combined.get(folder);
  }

  return {
    ignores(relative: string, dir: boolean): boolean {
      // A folder above that is left out takes everything in it along, and no
      // rule further down can bring a file back out of it - git's rule too.
      const parts = relative.split(path.sep);
      for (let depth = 1; depth <= parts.length; depth += 1) {
        const here = parts.slice(0, depth).join(path.sep);
        const isDir = depth < parts.length || dir;
        if (rulesFor(parts.slice(0, depth - 1).join(path.sep)).ignores(asPattern(here, isDir))) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * The rules for a project, or undefined when it has none: no `.gitignore` at
 * its top or its repository's, and no `.git-ftp-ignore`.
 *
 * `top` is the folder the connection maps, which is where a project without
 * a repository keeps its files.
 */
export async function ignoreRulesFor(
  top: string,
  option: { findRepo?: FindRepo; askGit?: (root: string) => AskGit } = {}
): Promise<IgnoreRules | undefined> {
  const findRepo = option.findRepo || repoOf;
  const askGit = option.askGit || viaGit;

  const repo = await findRepo(top);
  const base = repo || top;
  const sources: string[] = [];

  const hasGitignore =
    readOrUndefined(path.join(base, '.gitignore')) !== undefined ||
    readOrUndefined(path.join(top, '.gitignore')) !== undefined;
  if (hasGitignore) {
    sources.push('.gitignore');
  }

  const ftpIgnore = [base, top]
    .filter((one, at, all) => all.indexOf(one) === at)
    .map(folder => ({ folder, text: readOrUndefined(path.join(folder, GIT_FTP_IGNORE)) }))
    .find(one => one.text !== undefined);
  const ftpRules = ftpIgnore ? GitIgnore().add(ftpIgnore.text!) : undefined;
  if (ftpIgnore) {
    sources.push(path.relative(top, path.join(ftpIgnore.folder, GIT_FTP_IGNORE)) || GIT_FTP_IGNORE);
  }

  if (sources.length === 0) {
    return undefined;
  }

  const git = repo ? askGit(repo) : undefined;
  const gitignores = repo ? undefined : readGitignores(top);

  async function ignoredAmong(candidates: Candidate[]): Promise<Set<string>> {
    const ignored = new Set<string>();
    const forGit: Candidate[] = [];

    for (const one of candidates) {
      // The repository is never the site, whatever the rules forget to say.
      if (path.basename(one.path) === '.git') {
        ignored.add(one.path);
        continue;
      }

      if (ftpRules && ftpIgnore) {
        const relative = path.relative(ftpIgnore.folder, one.path);
        if (!outside(relative) && ftpRules.ignores(asPattern(relative, one.dir))) {
          ignored.add(one.path);
          continue;
        }
      }

      if (gitignores) {
        const relative = path.relative(top, one.path);
        if (!outside(relative) && gitignores.ignores(relative, one.dir)) {
          ignored.add(one.path);
        }
        continue;
      }

      forGit.push(one);
    }

    if (git && forGit.length > 0) {
      // A folder is asked with its slash: a folder that is not on this
      // machine is otherwise judged as a file, and `vendor/` does not match a
      // file called vendor.
      const asked = new Map<string, string>();
      forGit.forEach(one => {
        const relative = path.relative(repo!, one.path);
        if (!outside(relative)) {
          asked.set(asPattern(relative, one.dir), one.path);
        }
      });

      const answer = (await git(Array.from(asked.keys()))) || [];
      answer.forEach(one => {
        const found = asked.get(one);
        if (found) {
          ignored.add(found);
        }
      });
    }

    return ignored;
  }

  return { sources, ignoredAmong };
}

/**
 * Everything the rules leave out below a folder, as the topmost paths: a
 * folder that is left out is named once, and nothing in it is looked at.
 *
 * Asked a level at a time, so a deep tree is as many questions as it is
 * deep, not as it is wide. `list` names what is in a folder in terms of this
 * machine's paths, whichever side it is actually reading.
 */
export async function findIgnored(
  rules: IgnoreRules,
  start: string,
  list: (folder: string) => Promise<Candidate[]>,
  onFolder?: (folder: string) => void
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  let level = [start];

  while (level.length > 0) {
    const entries: Candidate[] = [];
    for (const folder of level) {
      if (onFolder) {
        onFolder(folder);
      }
      entries.push(...(await list(folder)));
    }

    const ignored = await rules.ignoredAmong(entries);
    level = [];
    entries.forEach(one => {
      if (ignored.has(one.path)) {
        found.push(one);
      } else if (one.dir) {
        level.push(one.path);
      }
    });
  }

  return found;
}

/** Whether a path is one of these, or inside one of them. */
export function within(paths: Set<string>, fsPath: string): boolean {
  let at = path.resolve(fsPath);
  for (;;) {
    if (paths.has(at)) {
      return true;
    }
    const up = path.dirname(at);
    if (up === at) {
      return false;
    }
    at = up;
  }
}
