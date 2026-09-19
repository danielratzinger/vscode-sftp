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
  /** Directories below this are not descended into. */
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

export interface WalkResult {
  files: Manifest[];
  /** True when a limit stopped the walk before it finished. */
  truncated: boolean;
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
  let directories = 0;
  let truncated = false;

  async function visit(dir: string, depth: number): Promise<void> {
    if (truncated || depth > option.maxDepth) {
      truncated = truncated || depth > option.maxDepth;
      return;
    }

    if (option.stopWhen && option.stopWhen()) {
      truncated = true;
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

    for (const entry of entries) {
      if (files.length >= option.maxFiles) {
        truncated = true;
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

  await visit(root, 0);

  return { files, truncated, directories };
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
