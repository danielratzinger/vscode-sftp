import { FileEntry, FileType } from '../core/fs';
import { isScriptFile, DEFAULT_EXCLUDED_EXTENSIONS } from '../core/scriptFiles';
import { isDenied } from './redaction';

/**
 * Search runs locally, over the file set the *remote manifest* defines.
 *
 * The manifest says which files exist; their content is read from wherever the
 * cache layer put it. Walking the workspace instead would be faster and wrong
 * in both directions: it would miss server files never materialised, and
 * invent files that are not deployed - `.git`, `node_modules`, build output,
 * work in progress. An agent asking what is on the server would get an answer
 * describing somebody's laptop.
 */

export interface Manifest {
  path: string;
  size: number;
  mtime: number;
}

export interface WalkOption {
  /**
   * How many levels of directory to list, counting the starting one as the
   * first: 1 lists what is in the given directory and descends no further,
   * which is what `find -maxdepth 1` and `tree -L 1` both mean by it.
   */
  maxDepth: number;
  /** Stops the walk once this many files are known. */
  maxFiles: number;
  excludeFolders: string[];
  excludeExtensions: string[];
  /**
   * Asked before each listing. A walk that has run out of time stops where it
   * is and reports what it has, which answers the question better than an
   * error would.
   */
  stopWhen?(): boolean;
}

export const DEFAULT_WALK: WalkOption = {
  maxDepth: 8,
  maxFiles: 2000,
  excludeFolders: [],
  excludeExtensions: DEFAULT_EXCLUDED_EXTENSIONS,
};

/** Why a walk stopped early. Each one has a different way out of it. */
export type WalkLimit = 'depth' | 'files' | 'time';

export interface WalkResult {
  files: Manifest[];
  /** True when a limit stopped the walk before it finished. */
  truncated: boolean;
  /**
   * Which limits it hit. Saying only that something was cut leaves the reader
   * to guess whether to ask for more depth, a narrower directory, or the same
   * question again - three different answers to what used to be one sentence.
   */
  stoppedBy: WalkLimit[];
  /** The deepest level reached, on the same count as `maxDepth`. */
  depth: number;
  directories: number;
}

/**
 * Builds the file set by listing directories, depth first, bounded. Each
 * listing is one round trip, so the bounds are what stop an agent's question
 * from walking an entire server.
 */
export async function walk(
  list: (dir: string) => Promise<FileEntry[]>,
  root: string,
  option: WalkOption
): Promise<WalkResult> {
  const files: Manifest[] = [];
  const excluded = option.excludeFolders.map(name => name.toLowerCase());
  const stoppedBy: WalkLimit[] = [];
  let directories = 0;
  let deepest = 0;
  // Set by the limits that apply to the walk as a whole. Depth is not one of
  // them: it prunes the branch it is reached in and nothing else. Treating it
  // as the end of the walk - which is what a single `truncated` flag invited -
  // meant one deep folder cut off every shallow one listed after it.
  let exhausted = false;

  const stop = (limit: WalkLimit) => {
    if (stoppedBy.indexOf(limit) === -1) {
      stoppedBy.push(limit);
    }
  };

  async function visit(dir: string, depth: number): Promise<void> {
    if (exhausted) {
      return;
    }

    if (depth > option.maxDepth) {
      stop('depth');
      return;
    }

    if (option.stopWhen && option.stopWhen()) {
      stop('time');
      exhausted = true;
      return;
    }

    let entries: FileEntry[];
    try {
      entries = await list(dir);
    } catch (error) {
      // An unreadable directory is not a reason to abandon the search.
      return;
    }

    directories += 1;
    deepest = Math.max(deepest, depth);

    for (const entry of entries) {
      if (files.length >= option.maxFiles) {
        stop('files');
        exhausted = true;
        return;
      }

      if (entry.type === FileType.Directory) {
        if (excluded.indexOf(entry.name.toLowerCase()) !== -1) {
          continue;
        }
        await visit(entry.fspath, depth + 1);
        continue;
      }

      if (entry.type !== FileType.File) {
        continue;
      }
      // Binary files are no use as text, and credentials are not ours to index.
      if (!isScriptFile(entry.fspath, option.excludeExtensions)) {
        continue;
      }
      if (isDenied(entry.fspath)) {
        continue;
      }

      files.push({ path: entry.fspath, size: entry.size, mtime: entry.mtime });
    }
  }

  await visit(root, 1);

  return {
    files,
    truncated: stoppedBy.length > 0,
    stoppedBy,
    depth: deepest,
    directories,
  };
}

export interface Match {
  path: string;
  line: number;
  text: string;
  /** Lines either side, when asked for. */
  before?: string[];
  after?: string[];
}

export interface ContentSearchOption {
  query: string;
  regex?: boolean;
  maxMatches: number;
  maxPerFile: number;
  context: number;
}

export function searchText(
  path: string,
  content: string,
  option: ContentSearchOption
): Match[] {
  const lines = content.split('\n');
  const matches: Match[] = [];

  let test: (line: string) => boolean;
  if (option.regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(option.query, 'i');
    } catch (error) {
      throw new Error(
        `That is not a valid pattern: ${error.message}. Supply the pattern ` +
          'only, with no delimiters and no trailing flags.'
      );
    }
    test = line => expression.test(line);
  } else {
    const needle = option.query.toLowerCase();
    test = line => line.toLowerCase().indexOf(needle) !== -1;
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (matches.length >= option.maxPerFile) {
      break;
    }
    if (!test(lines[i])) {
      continue;
    }

    const match: Match = { path, line: i + 1, text: lines[i] };
    if (option.context > 0) {
      match.before = lines.slice(Math.max(0, i - option.context), i);
      match.after = lines.slice(i + 1, i + 1 + option.context);
    }

    matches.push(match);
  }

  return matches;
}

/**
 * Path and filename matching, which is often what "where is the user model"
 * actually means, and costs nothing because the manifest is already here.
 */
export function searchPaths(files: Manifest[], query: string): Manifest[] {
  const needle = query.toLowerCase();
  const asGlob = needle.indexOf('*') !== -1 ? globToRegExp(needle) : null;

  return files.filter(file => {
    const lower = file.path.toLowerCase();
    return asGlob ? asGlob.test(lower) : lower.indexOf(needle) !== -1;
  });
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped);
}

/** Path hits first: a filename match is usually a stronger signal than a line. */
export function rank(matches: Match[], query: string): Match[] {
  const needle = query.toLowerCase();

  return matches.slice().sort((a, b) => {
    const aName = a.path.toLowerCase().indexOf(needle) !== -1 ? 0 : 1;
    const bName = b.path.toLowerCase().indexOf(needle) !== -1 ? 0 : 1;
    return aName - bName || a.path.localeCompare(b.path) || a.line - b.line;
  });
}
