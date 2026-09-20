import * as crypto from 'crypto';
import * as path from 'path';
import upath from '../core/upath';
import { FileEntry, FileType } from '../core/fs';
import * as fse from 'fs-extra';
import { ToolDefinition, ToolResult } from './protocol';
import {
  cachePathFor,
  CacheOption,
  LocalState,
  materialise,
  pruneCache,
} from './cache';
import {
  canReturnWhole,
  deniedMessage,
  isDenied,
  redact,
  RedactOption,
  redactionNote,
} from './redaction';
import {
  DEFAULT_WALK,
  Match,
  rank,
  searchPaths,
  searchText,
  walk,
  WalkLimit,
  WalkOption,
  WalkResult,
} from './search';
import { Budget, createBudget, UNLIMITED } from './budget';
import { describeOutline, outlineOf } from './outline';
import { diff as diffOf } from './diff';
import {
  contentOf,
  describeAge as describeVersionAge,
  versionsFor,
} from './localHistory';
import {
  keyFor,
  nextOffset,
  offsetOf,
  recall,
  remember,
} from './manifest';
import { isOperationTimeout } from '../core/fs/operationTimeout';
import { outsideMessage, resolveWithin } from './paths';
import {
  factsFrom,
  forget as forgetNote,
  identityOf,
  load as loadNotes,
  NoteState,
  overviewOf,
  prune,
  put as putNote,
  putOverview,
  reanchor,
  save as saveNotes,
  Version,
  viewOf,
} from './notes';

const OVERVIEW_FILES = [
  'composer.json',
  'package.json',
  'style.css',
  'README.md',
  'readme.md',
];

/** A note kept unconfirmed for longer than this is no longer a starting point. */
/**
 * A ceiling on one file, because every byte of it becomes context.
 *
 * Source files are kilobytes; what trips this is a log, a database dump or a
 * media file, none of which can be read as text anyway. Refusing before the
 * fetch also means a minified bundle is not dragged over FTP to be thrown away
 * at the far end.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Enough of a directory to work with; beyond this a listing is noise. */
const MAX_LIST_ENTRIES = 1000;

/** A page of a tree. The whole of a large one is more than anyone reads at once. */
const MAX_TREE_ENTRIES = 1000;

const MAX_STALE_AGE = 90 * 24 * 60 * 60 * 1000;
const MAX_NOTES = 5000;
import {
  ExposedConnection,
  ExposureOption,
  ServiceLike,
  exposedConnections,
  findExposed,
  UNKNOWN_SERVER,
} from './exposure';
import { stableId } from './identity';

/**
 * Everything the tools need from the extension, injected so the tool layer can
 * be exercised without a running editor.
 */
export interface ToolContext {
  services(): ServiceLike[];
  exposure(): ExposureOption;
  /** Resolved connection for a service, or a reason it cannot be reached. */
  remoteFs(service: ServiceLike): Promise<RemoteLike>;
  cacheOption(service: ServiceLike): CacheOption;
  /** Extra filenames never to serve, from settings. */
  deniedFiles?(): string[];
  /** Which redaction layers to run, from settings. */
  redaction?(): RedactOption;
  /** The largest file to read, from settings. */
  maxFileBytes?(): number;
  /** The ceiling on one call, from settings. */
  callTimeout?(): number;
  /** Where the editor keeps its local history, when it keeps one. */
  historyRoot?(): string | undefined;
  /** Copies kept when a download wrote over a local file. */
  replacedVersions?(
    service: ServiceLike,
    localPath: string
  ): Promise<Array<{ id: string; timestamp: number; read(): Promise<string> }>>;
  /** The URI string the editor knows a local file by. */
  uriFor?(localPath: string): string;
  walkOption?(service: ServiceLike): WalkOption;
  /** Told about a write into the project, so the watcher does not undo it. */
  onWorkspaceWrite?(localPath: string): void;
  localPathFor?(service: ServiceLike, remotePath: string): string;
}

export interface RemoteLike {
  list(dir: string): Promise<FileEntry[]>;
  lstat(fsPath: string): Promise<{ type: FileType; size: number; mtime: number }>;
  readFile(fsPath: string): Promise<string | Buffer>;
}

/** Lines are 1-based and inclusive, as every editor and stack trace has them. */
function sliceLines(text: string, from?: number, to?: number): string {
  if (from === undefined && to === undefined) {
    return text;
  }

  const lines = text.split('\n');
  const start = Math.max(1, from || 1);
  const end = Math.min(lines.length, to === undefined ? lines.length : to);

  return lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}\t${line}`)
    .join('\n');
}

const DIVERGENCE: { [key: string]: string } = {
  [LocalState.Newer]:
    'Your local copy is newer than the server\u2019s and has not been touched. ' +
    'The text below is what is on the server; `local-copy` returns yours.',
  [LocalState.Older]:
    'The server\u2019s copy is newer than your local one, which has been left alone. ' +
    'The text below is what is on the server; `local-copy` returns yours.',
};

const errorResult = (text: string): ToolResult => ({ text, isError: true });

/**
 * Why a stat failed, when the difference matters.
 *
 * `catch(() => undefined)` reads every failure as “the file is not there”,
 * which is a confident answer to a question nobody could answer: a server that
 * stopped replying tells you nothing about whether the file exists, and
 * reporting it as absent sends a model off to create what is already there.
 */
async function statOrReason(
  remote: RemoteLike,
  remotePath: string
): Promise<{ stat?: { type: FileType; size: number; mtime: number }; unreachable?: string }> {
  try {
    return { stat: await remote.lstat(remotePath) };
  } catch (error) {
    return isOperationTimeout(error)
      ? { unreachable: `${remotePath}: ${error.message}` }
      : {};
  }
}

/**
 * The shape of `structuredContent`, for the clients that validate it.
 *
 * Only the fields a caller should rely on are declared. `additionalProperties`
 * stays open because the text half of a result is the contract for people, and
 * the structured half grows.
 */
const objectSchema = (properties: object) => ({
  type: 'object',
  properties,
  additionalProperties: true,
});

const stringField = { type: 'string' };
const numberField = { type: 'number' };
const booleanField = { type: 'boolean' };

/**
 * The local path a remote one corresponds to, by the same mapping the explorer
 * uses: the part below `remotePath`, rebased onto the workspace folder.
 */
export function localPathFor(service: ServiceLike, remotePath: string): string {
  const config = service.getConfig();
  const relative = upath.relative(config.remotePath, remotePath);
  return path.join(service.baseDir, relative);
}

/**
 * A NUL byte in text is the one reliable sign that this is not text. Extension
 * lists miss the file called `dump` and the `.log` full of binary framing.
 */
function looksBinary(text: string): boolean {
  return text.slice(0, 8000).indexOf('\u0000') !== -1;
}

function describeSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  }
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

function describeEntry(entry: FileEntry): string {
  const kind = entry.type === FileType.Directory ? 'dir ' : 'file';
  const size = entry.type === FileType.Directory ? '' : ` ${entry.size}`;
  return `${kind} ${entry.name}${size}`;
}

/**
 * A window of time written the way somebody says it: `7d`, `48h`, `30m`, or a
 * date. Anything unparseable means no window rather than an error, because a
 * listing is still useful and refusing one over a typo is not.
 */
export function since(value: any, now: number = Date.now()): number | undefined {
  if (typeof value === 'number' && isFinite(value)) {
    // A plain number is a timestamp if it looks like one, days otherwise.
    return value > 1e11 ? value : now - value * 24 * 60 * 60 * 1000;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const text = value.trim();
  const relative = /^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|d|day|days|w|week|weeks)$/i.exec(
    text
  );

  if (relative) {
    const amount = parseFloat(relative[1]);
    const unit = relative[2].toLowerCase();
    const minute = 60 * 1000;
    const scale = unit.charAt(0) === 'm'
      ? minute
      : unit.charAt(0) === 'h'
      ? 60 * minute
      : unit.charAt(0) === 'w'
      ? 7 * 24 * 60 * minute
      : 24 * 60 * minute;

    return now - amount * scale;
  }

  const parsed = Date.parse(text);

  return isNaN(parsed) ? undefined : parsed;
}

/**
 * A note describes one version of a file. Anywhere we already hold the remote
 * stat, we can say whether the description still holds - and say it at the
 * moment the caller has what it needs to put it right.
 */
async function noteFor(
  context: ToolContext,
  service: ServiceLike,
  remotePath: string,
  current: Version
) {
  const store = await loadNotes(
    context.cacheOption(service).cacheRoot,
    stableId(service)
  );

  return viewOf(store, remotePath, current);
}

/**
 * The same, for the one caller that has the file's bytes rather than its
 * listing - and which can therefore settle what a listing only guesses at.
 *
 * Every deploy here is an upload, and an upload restamps every file it
 * copies. Against a timestamp, a redeploy of unchanged code marks every
 * description on the server stale at once; against the content, nothing has
 * changed and the descriptions stand. So a note whose hash still matches is
 * re-anchored to the version in front of us, and stops being asked about.
 */
async function confirmNote(
  context: ToolContext,
  service: ServiceLike,
  remotePath: string,
  current: Version
) {
  const root = context.cacheOption(service).cacheRoot;
  const id = stableId(service);
  const store = await loadNotes(root, id);
  const note = store.files[remotePath];
  const view = viewOf(store, remotePath, current);

  const unchanged =
    note &&
    ((note.hash && note.hash === current.hash) ||
      // Written before notes carried a hash, and still describing this
      // version by the older measure: give it one.
      (!note.hash &&
        note.size === current.size &&
        Math.floor(note.mtime / 1000) === Math.floor(current.mtime / 1000)));

  if (unchanged && (note.mtime !== current.mtime || !note.hash)) {
    await saveNotes(
      root,
      id,
      reanchor(store, remotePath, current),
      identityOf(service.workspace, service.getConfig())
    ).catch(() => undefined);
  }

  return view;
}

/**
 * The hash of the copy on this machine, when it is the same version the
 * server has. Nothing is transferred for it.
 */
async function hashOfCopy(
  context: ToolContext,
  service: ServiceLike,
  remotePath: string,
  size: number
): Promise<string | undefined> {
  const option = context.cacheOption(service);
  const candidates = [
    (context.localPathFor || localPathFor)(service, remotePath),
    cachePathFor(option, stableId(service), remotePath),
  ];

  for (const file of candidates) {
    try {
      const stat = await fse.stat(file);
      if (stat.size !== size) {
        continue;
      }

      return hashOf(await fse.readFile(file));
    } catch (error) {
      // Not there, or not readable. The note simply goes without one.
    }
  }

  return undefined;
}

function describeNote(view: {
  state: NoteState;
  summary?: string;
  detail?: string;
}): string {
  const more = view.detail ? `\n${view.detail}` : '';

  if (view.state === NoteState.Current) {
    return `Noted: ${view.summary}${more}`;
  }

  if (view.state === NoteState.Stale) {
    return (
      `A description of an older version says: ${view.summary}. The file has ` +
      'changed since. If it is no longer right, put it right with `note`.' +
      more
    );
  }

  return '';
}

export function createTools(
  context: ToolContext,
  /** Connections other windows have registered with this one. */
  peerConnections: () => ExposedConnection[] = () => []
): ToolDefinition[] {
  const redaction = (): RedactOption =>
    context.redaction ? context.redaction() : {};

  /**
   * What is left of this call's time. The tools that loop ask between round
   * trips; the dispatcher stops anything that does not.
   */
  const budgetFor = (): Budget =>
    context.callTimeout ? createBudget(context.callTimeout()) : UNLIMITED;

  /**
   * The file list for a walk, fresh on the first page and remembered for the
   * next one. A continuation that re-walked every directory would make reading
   * on more expensive than starting over, which is no way to offer paging.
   */
  async function manifestOf(
    service: ServiceLike,
    remote: RemoteLike,
    root: string,
    option: WalkOption,
    offset: number,
    budget: Budget
  ) {
    const key = keyFor(stableId(service), root, option);

    if (offset > 0) {
      const cached = recall(key);
      if (cached) {
        return cached;
      }
    }

    const found = await walk(dir => remote.list(dir), root, {
      ...option,
      stopWhen: () => budget.spent(),
    });
    remember(key, found);

    return found;
  }

  const sizeLimit = (): number => {
    const configured = context.maxFileBytes ? context.maxFileBytes() : 0;
    return configured > 0 ? configured : MAX_FILE_BYTES;
  };

  /**
   * A path argument, canonical and inside what this connection exposes.
   *
   * Every tool runs its path through here before anything is read, written or
   * keyed on it. See `paths.ts` for why.
   */
  function within(service: ServiceLike, candidate: any): string | undefined {
    return typeof candidate === 'string'
      ? resolveWithin(service.getConfig().remotePath, candidate)
      : undefined;
  }

  const outside = (service: ServiceLike, candidate: any) =>
    errorResult(outsideMessage(service.getConfig().remotePath, String(candidate)));

  /** Resolve a connection id, or explain its absence the same way every time. */
  function resolve(serverId: any): ServiceLike | undefined {
    if (typeof serverId !== 'string' || serverId === '') {
      return undefined;
    }

    return findExposed(context.services(), context.exposure(), serverId);
  }

  const servers: ToolDefinition = {
    name: 'servers',
    title: 'List servers',
    description:
      'The servers available to read from, with what each one is where known. ' +
      'Call this first: every other tool takes one of these ids, or the name ' +
      'beside it when no other connection shares that name. An id stays the ' +
      'same for as long as the connection points at the same place, so one ' +
      'from an earlier session is still good. Only servers open in the editor ' +
      'and marked as exposed appear here.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: objectSchema({
      servers: {
        type: 'array',
        items: objectSchema({
          id: stringField,
          name: stringField,
          protocol: stringField,
          host: stringField,
          port: numberField,
          username: stringField,
          remotePath: stringField,
          workspace: stringField,
          profile: stringField,
          summary: stringField,
        }),
      },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run() {
      const described = await Promise.all(
        context.services().map(async service => {
          try {
            const held = await loadNotes(
              context.cacheOption(service).cacheRoot,
              stableId(service)
            );
            const recorded = overviewOf(held, MAX_STALE_AGE);
            return recorded ? { id: stableId(service), summary: recorded.summary } : undefined;
          } catch (error) {
            // A listing that cannot read a note is still a listing.
            return undefined;
          }
        })
      );

      const summaries: { [id: string]: string } = {};
      described.forEach(one => {
        if (one) {
          summaries[one.id] = one.summary;
        }
      });

      const connections = exposedConnections(
        context.services(),
        context.exposure()
      ).concat(peerConnections());

      if (connections.length === 0) {
        return {
          text:
            'No servers are exposed. Open a project with a .vscode/sftp.json in ' +
            'the editor, and check that its connection is not hidden with ' +
            '"mcp": { "exposed": false }.',
          structured: { servers: [] },
        };
      }

      // What somebody recorded about each one, which is the difference between
      // a list of hostnames and a list of projects.
      const listed = connections.map(connection =>
        summaries[connection.id]
          ? { ...connection, summary: summaries[connection.id] }
          : connection
      );

      return {
        text: listed.map(describeConnectionLine).join('\n'),
        structured: { servers: listed },
      };
    },
  };

  const list: ToolDefinition = {
    name: 'list',
    title: 'List a directory',
    description:
      'One directory on the server, as it is right now. Cheaper than searching ' +
      'when you already know roughly where to look.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        path: {
          type: 'string',
          description:
            'Absolute remote path. Defaults to the remote root of the server.',
        },
        offset: {
          type: 'integer',
          description:
            'Skip this many entries, to read on past a long listing. Use the ' +
            'nextOffset the previous call returned.',
        },
      },
      required: ['server'],
    },
    outputSchema: objectSchema({
      path: stringField,
      offset: numberField,
      total: numberField,
      nextOffset: numberField,
      truncated: booleanField,
      entries: {
        type: 'array',
        items: objectSchema({
          name: stringField,
          path: stringField,
          type: stringField,
          size: numberField,
          mtime: numberField,
        }),
      },
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }

      const dir = args.path
        ? within(service, args.path)
        : service.getConfig().remotePath;
      if (!dir) {
        return outside(service, args.path);
      }
      const remote = await context.remoteFs(service);
      const entries = await remote.list(dir);

      if (entries.length === 0) {
        return { text: `${dir} is empty.`, structured: { path: dir, entries: [] } };
      }

      const sorted = entries.slice().sort(byDirectoryThenName);
      // A directory of ten thousand uploads is not a listing anyone reads; it
      // is context spent on nothing. Ten thousand uploads in one flat
      // directory is also common, and "narrow it with a subdirectory" is not
      // advice anyone can take when there are none - so there is a way on.
      const offset = offsetOf(args.offset, sorted.length);
      const shown = sorted.slice(offset, offset + MAX_LIST_ENTRIES);
      const next = nextOffset(sorted.length, offset, shown.length);

      return {
        text:
          `${dir} (${sorted.length}` +
          (offset > 0 || next !== undefined
            ? `, showing ${offset + 1}-${offset + shown.length}`
            : '') +
          ')\n' +
          shown.map(describeEntry).join('\n') +
          (next !== undefined
            ? `\n… and ${sorted.length - next} more. Call again with ` +
              `offset: ${next} for the rest, or use \`search\` to find what ` +
              'you are after.'
            : ''),
        structured: {
          path: dir,
          offset,
          total: sorted.length,
          nextOffset: next,
          truncated: next !== undefined,
          entries: shown.map(entry => ({
            name: entry.name,
            path: entry.fspath,
            type: entry.type === FileType.Directory ? 'directory' : 'file',
            size: entry.size,
            mtime: entry.mtime,
          })),
        },
      };
    },
  };

  const stat: ToolDefinition = {
    name: 'stat',
    title: 'Compare one path',
    description:
      'How one path stands: whether it exists on the server, whether a local ' +
      'copy exists, and whether they agree. Use it before assuming a file you ' +
      'read earlier is still current, and on a file you do not know — it ' +
      'gives the size and the modification time without transferring ' +
      'anything, so you can choose a line range deliberately instead of ' +
      'pulling a megabyte to find out it was a megabyte.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        path: { type: 'string', description: 'Absolute remote path.' },
      },
      required: ['server', 'path'],
    },
    outputSchema: objectSchema({
      path: stringField,
      localPath: stringField,
      state: stringField,
      size: numberField,
      mtime: numberField,
      type: stringField,
      // See `read`: declared, because it is returned.
      note: objectSchema({
        state: stringField,
        summary: stringField,
        describedMtime: numberField,
        /** Descriptions this one replaced, newest first. */
        detail: stringField,
        previous: objectSchema({
          summary: stringField,
          detail: stringField,
          updated: numberField,
        }),
      }),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }
      if (typeof args.path !== 'string' || args.path === '') {
        return errorResult('A path is required.');
      }

      const target = within(service, args.path);
      if (!target) {
        return outside(service, args.path);
      }

      const remote = await context.remoteFs(service);
      const looked = await statOrReason(remote, target);
      if (looked.unreachable) {
        return errorResult(looked.unreachable);
      }
      const remoteStat = looked.stat;

      const toLocal = context.localPathFor || localPathFor;
      const localPath = toLocal(service, target);

      if (!remoteStat) {
        return {
          text: `${target} is not on the server.`,
          structured: { path: target, state: 'absent', localPath },
        };
      }

      const described = await noteFor(context, service, target, remoteStat);
      const about = describeNote(described);

      return {
        text:
          `${target}\n` +
          `  ${remoteStat.size} bytes, modified ${new Date(remoteStat.mtime).toISOString()}\n` +
          `  local copy would be at ${localPath}` +
          (about ? `\n  ${about}` : ''),
        structured: {
          path: target,
          localPath,
          size: remoteStat.size,
          mtime: remoteStat.mtime,
          type: remoteStat.type === FileType.Directory ? 'directory' : 'file',
          note: described,
        },
      };
    },
  };

  const fetch: ToolDefinition = {
    name: 'read',
    title: 'Read a file',
    description:
      'The contents of one file as it is on the server. Always the server\u2019s ' +
      'version, even when a local copy exists \u2014 you asked what is deployed. ' +
      'Give start_line and end_line to read part of a large file rather than all ' +
      'of it. If a local copy differs, the reply says so and `local-copy` ' +
      'returns that instead.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        path: { type: 'string', description: 'Absolute remote path.' },
        start_line: { type: 'integer', description: 'First line, 1-based.' },
        end_line: { type: 'integer', description: 'Last line, inclusive.' },
      },
      required: ['server', 'path'],
    },
    outputSchema: objectSchema({
      path: stringField,
      // The file itself. A client that reads the structured result and not the
      // text - which is what a client does once a tool declares a schema -
      // otherwise gets everything about the file except the file.
      content: stringField,
      state: stringField,
      source: stringField,
      localPath: stringField,
      localMtime: numberField,
      remoteMtime: numberField,
      redacted: { type: 'array', items: stringField },
      /**
       * Asking for a description, where understanding happens.
       *
       * In the text as well, but a client that reads structured output stops
       * reading the text - which is where every nudge lived until now, and is
       * why after a day of heavy use exactly one note had been written.
       */
      hint: stringField,
      // What `note` recorded about this file, if anything: a declared field
      // rather than an undeclared extra, because a client that validates the
      // schema strictly is entitled to reject what it was not promised.
      note: objectSchema({
        state: stringField,
        summary: stringField,
        describedMtime: numberField,
        /** Descriptions this one replaced, newest first. */
        detail: stringField,
        previous: objectSchema({
          summary: stringField,
          detail: stringField,
          updated: numberField,
        }),
      }),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }
      if (typeof args.path !== 'string' || args.path === '') {
        return errorResult('A path is required.');
      }

      const target = within(service, args.path);
      if (!target) {
        return outside(service, args.path);
      }

      const remote = await context.remoteFs(service);
      const looked = await statOrReason(remote, target);
      if (looked.unreachable) {
        return errorResult(looked.unreachable);
      }
      const remoteStat = looked.stat;
      if (!remoteStat) {
        return errorResult(`${target} is not on the server.`);
      }
      if (remoteStat.type === FileType.Directory) {
        return errorResult(`${target} is a directory. Use \`list\`.`);
      }

      const limit = sizeLimit();

      // A denied file is never materialised: a copy of production credentials
      // on the laptop is the same problem one step removed. What it can give
      // is the names in it, read into memory and dropped again - see
      // `outline.ts` for why that is safe and the refusal is not the only
      // useful answer.
      if (isDenied(target, context.deniedFiles ? context.deniedFiles() : [])) {
        if (remoteStat.size > limit) {
          return errorResult(deniedMessage(target));
        }

        const bytes = await remote.readFile(target).catch(() => undefined);
        const outline =
          bytes === undefined
            ? undefined
            : outlineOf(target, bytes.toString('utf8'));

        if (!outline) {
          return errorResult(deniedMessage(target));
        }

        return {
          text: `${describeOutline(target, outline)}\n\n${outline.text}`,
          structured: {
            path: target,
            content: outline.text,
            state: 'withheld',
            source: 'names-only',
            redacted: ['denied-file'],
          },
        };
      }

      if (remoteStat.size > limit) {
        return errorResult(
          `${target} is ${describeSize(remoteStat.size)}, over the ` +
            `${describeSize(limit)} limit, so it was not fetched. If it is ` +
            'source you need, raise sftp.mcp.maxFileBytes; if it is a log or ' +
            'a dump, `search` finds lines in it without reading it whole.'
        );
      }

      const toLocal = context.localPathFor || localPathFor;
      const result = await materialise(
        {
          connectionId: stableId(service),
          remotePath: target,
          localPath: toLocal(service, target),
          remote: { size: remoteStat.size, mtime: remoteStat.mtime },
          option: context.cacheOption(service),
        },
        {
          read: async remotePath => {
            const bytes = await remote.readFile(remotePath);
            return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
          },
          onWorkspaceWrite: context.onWorkspaceWrite,
        }
      );

      const raw = await fse.readFile(result.contentPath, 'utf8');
      if (looksBinary(raw)) {
        // Returning this as text produces pages of replacement characters that
        // cost context and say nothing. The file itself is on disk, intact.
        return errorResult(
          `${target} is not a text file. It is on this machine at ` +
            `${result.contentPath} if something else can read it.`
        );
      }

      const scrubbed = redact(raw, redaction());

      const wholeFile = args.start_line === undefined && args.end_line === undefined;
      if (wholeFile && !canReturnWhole(scrubbed.text)) {
        // Half a file is bad; a file with placeholders where credentials were
        // is worse, because saving it would overwrite the live values.
        return errorResult(
          `${target} has credentials in it, which were replaced before it ` +
            'reached here, so it cannot be handed back whole. Read the range ' +
            'you need with start_line and end_line and describe changes line ' +
            'by line.'
        );
      }

      const body = sliceLines(scrubbed.text, args.start_line, args.end_line);
      // The server's bytes, not the redacted view of them: the note describes
      // the file, and a marker in place of a credential is ours, not its.
      const version = {
        mtime: remoteStat.mtime,
        size: remoteStat.size,
        hash: hashOf(raw),
      };
      const described = await confirmNote(context, service, target, version);
      const hint = askForANote(stableId(service), target, described, remoteStat.size);

      const notes = [
        DIVERGENCE[result.state],
        redactionNote(scrubbed.found, scrubbed.secrets.length),
        describeNote(described),
        hint,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        text: notes ? `${notes}\n\n${body}` : body,
        structured: {
          path: target,
          content: body,
          state: result.state,
          source: result.source,
          localPath: result.localPath,
          localMtime: result.localMtime,
          remoteMtime: result.remoteMtime,
          redacted: scrubbed.found,
          note: described,
          hint: hint || undefined,
        },
      };
    },
  };

  const fetchLocal: ToolDefinition = {
    name: 'local-copy',
    title: 'Read the working copy',
    description:
      'The contents of the copy on this machine, which is only worth asking ' +
      'for when `read` reported that it differs from the server. Everything ' +
      'else returns the server\u2019s version.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        path: { type: 'string', description: 'Absolute remote path.' },
        start_line: { type: 'integer', description: 'First line, 1-based.' },
        end_line: { type: 'integer', description: 'Last line, inclusive.' },
      },
      required: ['server', 'path'],
    },
    outputSchema: objectSchema({
      path: stringField,
      content: stringField,
      localPath: stringField,
      source: stringField,
      redacted: { type: 'array', items: stringField },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }
      if (typeof args.path !== 'string' || args.path === '') {
        return errorResult('A path is required.');
      }

      const target = within(service, args.path);
      if (!target) {
        return outside(service, args.path);
      }

      const toLocal = context.localPathFor || localPathFor;
      const localPath = toLocal(service, target);

      if (isDenied(target, context.deniedFiles ? context.deniedFiles() : [])) {
        return errorResult(deniedMessage(target));
      }

      let text: string;
      try {
        text = await fse.readFile(localPath, 'utf8');
      } catch (error) {
        return errorResult(
          `There is no local copy of ${target} (looked at ${localPath}).`
        );
      }

      const scrubbed = redact(text, redaction());
      const body = sliceLines(scrubbed.text, args.start_line, args.end_line);
      const note = redactionNote(scrubbed.found, scrubbed.secrets.length);

      return {
        text: note ? `${note}\n\n${body}` : body,
        structured: {
          path: target,
          content: body,
          localPath,
          source: 'workspace',
          redacted: scrubbed.found,
        },
      };
    },
  };

  const search: ToolDefinition = {
    name: 'search',
    title: 'Search the server',
    description:
      'Find text in the files on the server, and files whose path matches. ' +
      'Scope it with dir wherever you can: the files have to be fetched before ' +
      'they can be searched, so a whole server costs far more than a folder. ' +
      'The first search over a folder downloads it; later ones only re-fetch ' +
      'what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        query: { type: 'string', description: 'Text to find, or a pattern with regex: true.' },
        dir: {
          type: 'string',
          description: 'Folder to search. Defaults to the whole remote root, which is slow.',
        },
        regex: {
          type: 'boolean',
          description: 'Treat query as a case-insensitive pattern. No delimiters, no flags.',
        },
        offset: {
          type: 'integer',
          description:
            'Resume after this many files, using the nextOffset the previous ' +
            'search returned. Continues where it stopped instead of searching ' +
            'the same files again.',
        },
        max_matches: { type: 'integer', description: 'Default 30, up to 300.' },
        max_per_file: { type: 'integer', description: 'Default 3, up to 100.' },
        context: { type: 'integer', description: 'Lines either side of a hit, up to 10.' },
      },
      required: ['server', 'query'],
    },
    outputSchema: objectSchema({
      matches: {
        type: 'array',
        items: objectSchema({
          path: stringField,
          line: numberField,
          text: stringField,
        }),
      },
      paths: { type: 'array', items: stringField },
      scanned: numberField,
      fetched: numberField,
      offset: numberField,
      searchedUpTo: numberField,
      nextOffset: numberField,
      total: numberField,
      truncated: booleanField,
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }
      if (typeof args.query !== 'string' || args.query === '') {
        return errorResult('A query is required.');
      }

      const option = context.walkOption
        ? context.walkOption(service)
        : DEFAULT_WALK;
      const remote = await context.remoteFs(service);
      const root = args.dir
        ? within(service, args.dir)
        : service.getConfig().remotePath;
      if (!root) {
        return outside(service, args.dir);
      }

      const budget = budgetFor();
      const from = offsetOf(args.offset, Number.MAX_SAFE_INTEGER);
      const found = await manifestOf(service, remote, root, option, from, budget);
      if (found.files.length === 0) {
        return {
          text: `No files to search under ${root}.`,
          structured: { matches: [], scanned: 0 },
        };
      }

      const maxMatches = clamp(args.max_matches, 30, 300);
      const searchOption = {
        query: args.query,
        regex: Boolean(args.regex),
        maxMatches,
        maxPerFile: clamp(args.max_per_file, 3, 100),
        context: clamp(args.context, 0, 10),
      };

      const matches: Match[] = [];
      const limit = sizeLimit();
      let outOfTime = false;
      let scanned = 0;
      let fetched = 0;
      let skipped = 0;
      let failed = 0;
      let firstFailure = '';
      // Where the next search picks up: the file after the last one this call
      // looked at, whatever it was that stopped it.
      let reached = Math.min(from, found.files.length);

      for (const file of found.files.slice(from)) {
        if (matches.length >= maxMatches) {
          break;
        }
        // Whatever has been found by now is worth more than an error saying
        // the question took too long.
        if (budget.spent()) {
          outOfTime = true;
          break;
        }

        reached += 1;
        // Skipped before the fetch: a search should not pull a database dump
        // across the wire to find nothing in it.
        if (file.size > limit) {
          skipped += 1;
          continue;
        }

        const result = await materialise(
          {
            connectionId: stableId(service),
            remotePath: file.path,
            localPath: (context.localPathFor || localPathFor)(service, file.path),
            remote: { size: file.size, mtime: file.mtime },
            option: context.cacheOption(service),
          },
          {
            read: async remotePath => {
              const bytes = await remote.readFile(remotePath);
              return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
            },
            onWorkspaceWrite: context.onWorkspaceWrite,
          }
        ).catch(error => {
          failed += 1;
          firstFailure = firstFailure || (error && error.message) || 'unknown';
          return undefined;
        });

        if (!result) {
          continue;
        }
        if (result.written) {
          fetched += 1;
        }
        scanned += 1;

        let content: string;
        try {
          content = await fse.readFile(result.contentPath, 'utf8');
        } catch (error) {
          continue;
        }
        if (looksBinary(content)) {
          skipped += 1;
          continue;
        }

        // Scrubbed before it is searched, so a snippet cannot leak what
        // `read` would have hidden.
        const scrubbed = redact(content, redaction());
        try {
          matches.push(...searchText(file.path, scrubbed.text, searchOption));
        } catch (error) {
          return errorResult(error.message);
        }
      }

      // A search that could not read anything has not searched. Reporting no
      // matches would say the text is not there, which is a different claim
      // and one nobody could tell apart from the truth.
      if (scanned === 0 && failed > 0) {
        return errorResult(
          `Nothing could be read under ${root}: ${failed} ` +
            `${failed === 1 ? 'file' : 'files'} failed, the first with ` +
            `“${firstFailure}”. This is not a result of no matches.`
        );
      }

      const byPath = searchPaths(found.files, args.query);
      const ordered = rank(matches, args.query).slice(0, maxMatches);
      const next = nextOffset(found.files.length, 0, reached);

      return {
        text: describeSearch(ordered, byPath, {
          root,
          scanned,
          fetched,
          skipped,
          failed,
          outOfTime,
          nextOffset: next,
          walk: found,
          depth: option.maxDepth,
          more: matches.length > ordered.length,
        }),
        structured: {
          matches: ordered,
          paths: byPath.map(file => file.path),
          scanned,
          fetched,
          offset: from,
          searchedUpTo: reached,
          nextOffset: next,
          total: found.files.length,
          truncated: found.truncated,
        },
      };
    },
  };

  const tree: ToolDefinition = {
    name: 'tree',
    title: 'The shape of the server',
    description:
      'The directory structure, with what each file is for where that is ' +
      'known. Call this before searching: it is the cheapest way to work out ' +
      'where to look, and it tells you which files have already been ' +
      'described.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        dir: { type: 'string', description: 'Where to start. Defaults to the remote root.' },
        depth: {
          type: 'integer',
          description:
            'How many directory levels to list, counting dir as the first: ' +
            '1 lists only what is in dir, 2 adds its subdirectories, and so ' +
            'on. Default 3.',
        },
        offset: {
          type: 'integer',
          description:
            'Skip this many files, to read on past a large tree. Use the ' +
            'nextOffset the previous call returned; the tree is not walked ' +
            'again for it.',
        },
        since: {
          type: 'string',
          description:
            'Only files changed since then: "7d", "48h", or a date. This is ' +
            'how to answer \u201cwhat did the last deploy touch\u201d, and it is usually ' +
            'a better first question than reading the whole tree.',
        },
        sort: {
          type: 'string',
          description: '"path" (default) or "modified", newest first.',
        },
      },
      required: ['server'],
    },
    outputSchema: objectSchema({
      root: stringField,
      offset: numberField,
      total: numberField,
      nextOffset: numberField,
      truncated: booleanField,
      stoppedBy: { type: 'array', items: stringField },
      depth: numberField,
      files: {
        type: 'array',
        items: objectSchema({
          path: stringField,
          size: numberField,
          state: stringField,
          summary: stringField,
        }),
      },
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }

      const base = context.walkOption ? context.walkOption(service) : DEFAULT_WALK;
      const remote = await context.remoteFs(service);
      const root = args.dir
        ? within(service, args.dir)
        : service.getConfig().remotePath;
      if (!root) {
        return outside(service, args.dir);
      }
      const treeBudget = budgetFor();
      // At least one level: a depth of zero would list nothing at all and
      // report a limit for it, which is never what anybody meant to ask.
      const askedDepth = Math.max(1, clamp(args.depth, 3, base.maxDepth));
      const option = { ...base, maxDepth: askedDepth };
      const from = offsetOf(args.offset, Number.MAX_SAFE_INTEGER);
      const found = await manifestOf(
        service,
        remote,
        root,
        option,
        from,
        treeBudget
      );

      const cacheRoot = context.cacheOption(service).cacheRoot;
      const notes = await loadNotes(cacheRoot, stableId(service));

      // What changed is a different question from what exists, and the walk
      // already carries the times that answer it.
      const changedSince = since(args.since);
      const selected = changedSince
        ? found.files.filter(file => file.mtime >= changedSince)
        : found.files.slice();

      if (args.sort === 'modified' || changedSince) {
        selected.sort((a, b) => b.mtime - a.mtime);
      }

      const page = selected.slice(from, from + MAX_TREE_ENTRIES);
      const next = nextOffset(selected.length, from, page.length);

      const lines = page.map(file => {
        const when =
          changedSince || args.sort === 'modified'
            ? `  ${new Date(file.mtime).toISOString().slice(0, 16).replace('T', ' ')}  `
            : '';
        const view = viewOf(notes, file.path, file);
        const described =
          view.state === NoteState.Current
            ? ` \u2014 ${view.summary}`
            : view.state === NoteState.Stale
            ? ` \u2014 ${view.summary} (stale: the file has changed since)`
            : '';
        return `${when}${file.path}${described}`;
      });

      // One lookup instead of a scan per note: a full tree and a full note
      // store are thousands each.
      const present: { [remotePath: string]: true } = {};
      found.files.forEach(file => {
        present[file.path] = true;
      });

      const survivors = prune(notes, {
        present: p => present[p] === true,
        maxStaleAge: MAX_STALE_AGE,
        maxNotes: MAX_NOTES,
      });
      if (survivors.removed.length > 0 && !found.truncated) {
        // Only when the walk was complete: a truncated one would look like
        // half the server had been deleted.
        await saveNotes(
          cacheRoot,
          stableId(service),
          survivors.store,
          identityOf(service.workspace, service.getConfig())
        );
      }

      if (!found.truncated) {
        // The bytes get the same sweep as the notes. Only below the walked
        // root, because that is all this walk knows about; a file the walk
        // skips by extension is re-fetched on demand, which costs a round trip
        // and never the wrong answer.
        await pruneCache(
          context.cacheOption(service),
          stableId(service),
          cached =>
            present[cached] === true || resolveWithin(root, cached) === undefined
        ).catch(() => []);
      }

      const describedCount = found.files.filter(
        file => viewOf(notes, file.path, file).state !== NoteState.None
      ).length;

      if (changedSince && selected.length === 0) {
        return {
          text:
            `Nothing under ${root} has changed since ` +
            `${new Date(changedSince).toISOString()}.`,
          structured: { root, total: 0, files: [] },
        };
      }

      return {
        text:
          (changedSince
            ? `${selected.length} files under ${root} changed since ` +
              `${new Date(changedSince).toISOString().slice(0, 10)}, `
            : `${found.files.length} files under ${root}, `) +
          `${describedCount} described` +
          (from > 0 || next !== undefined
            ? `, showing ${from + 1}-${from + page.length}`
            : '') +
          (found.truncated ? ` (${limitsOf(found, askedDepth)})` : '') +
          '.\n' +
          (describedCount < found.files.length
            ? 'Record what a file is for with note as you learn it.\n'
            : '') +
          (next !== undefined
            ? `Call again with offset: ${next} for the rest; the tree is ` +
              'already walked, so it costs nothing.\n'
            : '') +
          '\n' +
          lines.join('\n'),
        structured: {
          root,
          offset: from,
          total: selected.length,
          nextOffset: next,
          truncated: found.truncated,
          stoppedBy: found.stoppedBy,
          depth: found.depth,
          files: page.map(file => ({
            path: file.path,
            size: file.size,
            ...viewOf(notes, file.path, file),
          })),
        },
      };
    },
  };

  const recordNote: ToolDefinition = {
    name: 'note',
    title: 'Record what a file or a project is for',
    description:
      'Save a description of something you have just understood, so it shows ' +
      'up next time - for you, later, or for anyone else working on this ' +
      'server. With a path it describes that file and appears in `tree`; ' +
      'without one it describes the whole project and appears in `servers` ' +
      'and `overview`, which is where to put what a server is actually for. ' +
      'Writes only to this machine, never to the server. Describe the ' +
      'purpose, not the contents. Replacing what is there is expected - a ' +
      'description is written from whatever its writer was reading the file ' +
      'for, and grows as people come to it for other things - so keep what ' +
      'still holds and add what it missed. The lines it replaces are kept.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        path: {
          type: 'string',
          description:
            'Absolute remote path. Leave it out to describe the project as a ' +
            'whole.',
        },
        summary: {
          type: 'string',
          description:
            'One line: what it is for. It appears beside the path in `tree`, ' +
            'so it has to stay a line.',
        },
        detail: {
          type: 'string',
          description:
            'Everything else worth knowing about it, as it stands. Read what ' +
            'is already here, fold in what you have just learned, and write ' +
            'the whole thing back - this is the description developing, not a ' +
            'note appended to the last one.',
        },
      },
      required: ['server', 'summary'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }
      if (typeof args.summary !== 'string' || args.summary.trim() === '') {
        return errorResult('A summary is required.');
      }

      const summary = args.summary.trim();
      const detail =
        typeof args.detail === 'string' && args.detail.trim() !== ''
          ? args.detail.trim()
          : undefined;
      const describingProject = args.path === undefined || args.path === '';

      if (summary.length > LONGEST_SUMMARY) {
        return errorResult(
          `That line is ${summary.length} characters; ${LONGEST_SUMMARY} is ` +
            'the limit. It shares a line with the path in `tree`, so it has ' +
            'to say what this is for and stop - everything else goes in ' +
            '`detail`, which has room for it.'
        );
      }

      if (detail && detail.length > LONGEST_DETAIL) {
        return errorResult(
          `That description is ${detail.length} characters; ${LONGEST_DETAIL} ` +
            'is the limit. It is meant to be what is worth knowing about ' +
            'this, synthesised - not everything anybody has ever noticed.'
        );
      }

      if (describingProject) {
        const root = context.cacheOption(service).cacheRoot;
        const key = stableId(service);
        const held = await loadNotes(root, key);

        await saveNotes(
          root,
          key,
          putOverview(held, summary, detail),
          identityOf(service.workspace, service.getConfig())
        );

        return {
          text:
            `Noted what ${service.getConfig().name || service.name} is: ` +
            `${summary}\n` +
            '`servers` and `overview` will say so from now on.',
        };
      }

      if (typeof args.path !== 'string') {
        return errorResult('A path must be a string, or left out entirely.');
      }

      const target = within(service, args.path);
      if (!target) {
        return outside(service, args.path);
      }

      const remote = await context.remoteFs(service);
      const looked = await statOrReason(remote, target);
      if (looked.unreachable) {
        return errorResult(looked.unreachable);
      }
      if (!looked.stat) {
        return errorResult(`${target} is not on the server.`);
      }
      const remoteStat = looked.stat;

      const cacheRoot = context.cacheOption(service).cacheRoot;
      const id = stableId(service);
      const store = await loadNotes(cacheRoot, id);

      // Keyed by the version described, so the note goes stale by itself when
      // the file moves on rather than quietly describing something else. A
      // description is written just after a read, so the bytes it was written
      // about are already on this machine - no transfer, and only when what is
      // there is the same size as what the server has, so it is the same
      // version and not a stale copy.
      await saveNotes(
        cacheRoot,
        id,
        putNote(
          store,
          target,
          summary,
          {
            mtime: remoteStat.mtime,
            size: remoteStat.size,
            hash: await hashOfCopy(context, service, target, remoteStat.size),
          },
          detail
        ),
        identityOf(service.workspace, service.getConfig())
      );

      return { text: `Noted: ${target} \u2014 ${summary}` };
    },
  };

  const forgetNotes: ToolDefinition = {
    name: 'forget',
    title: 'Drop descriptions',
    description:
      'Remove the description of one file, or every description for a server. ' +
      'Also clears out notes for files the server no longer has.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        path: { type: 'string', description: 'One path. Leave it out to clear the lot.' },
      },
      required: ['server'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }

      const cacheRoot = context.cacheOption(service).cacheRoot;
      const id = stableId(service);
      const store = await loadNotes(cacheRoot, id);

      if (typeof args.path === 'string' && args.path !== '') {
        // Canonical here too, or a note recorded as `/srv/app/x` could not be
        // forgotten by asking for `/srv/app//x`.
        const target = within(service, args.path);
        if (!target) {
          return outside(service, args.path);
        }

        await saveNotes(
          cacheRoot,
          id,
          forgetNote(store, target),
          identityOf(service.workspace, service.getConfig())
        );
        return { text: `Forgot the description of ${target}.` };
      }

      const count = Object.keys(store.files).length;
      const hadOverview = Boolean(store.overview);
      await saveNotes(
        cacheRoot,
        id,
        forgetNote(store),
        identityOf(service.workspace, service.getConfig())
      );

      return {
        text:
          `Forgot ${count} file description${count === 1 ? '' : 's'}` +
          `${hadOverview ? ', and what the project is' : ''}.`,
      };
    },
  };

  const overview: ToolDefinition = {
    name: 'overview',
    title: 'What this project is',
    description:
      'What the project on a server appears to be: framework, name and ' +
      'description, taken from files like composer.json and package.json. ' +
      'Facts only - nothing here is inferred.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
      },
      required: ['server'],
    },
    outputSchema: objectSchema({
      server: stringField,
      root: stringField,
      // Whatever the project files said about themselves: a framework, a name,
      // a description. The keys are not fixed, because the facts are not.
      facts: { type: 'object', additionalProperties: { type: 'string' } },
      /** What somebody recorded with `note`, which the facts cannot tell you. */
      narrative: stringField,
      detail: stringField,
      recorded: numberField,
      stale: booleanField,
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }

      const config = service.getConfig();
      const remote = await context.remoteFs(service);
      const root = config.remotePath;

      const contents: { [remotePath: string]: string } = {};
      for (const name of OVERVIEW_FILES) {
        const remotePath = `${root.replace(/\/$/, '')}/${name}`;
        try {
          const bytes = await remote.readFile(remotePath);
          contents[remotePath] = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
        } catch (error) {
          // Not every project has every file; that is the usual case.
        }
      }

      const facts = factsFrom(contents);
      const held = await loadNotes(context.cacheOption(service).cacheRoot, stableId(service));
      const recorded = overviewOf(held, MAX_STALE_AGE);
      const lines = [
        `${config.name || config.host} \u2014 ${config.protocol}://${config.host}${root}`,
      ];

      if (recorded) {
        lines.push(
          '',
          recorded.summary +
            (recorded.detail ? `\n${recorded.detail}` : '') +
            (recorded.stale
              ? `\n(recorded ${describeVersionAge(recorded.updated)} and not confirmed since)`
              : '')
        );
      }

      if (Object.keys(facts).length === 0) {
        lines.push('', 'Nothing identifying found at the remote root.');
      } else {
        lines.push('');
        Object.keys(facts).forEach(label => lines.push(`${label}: ${facts[label]}`));
      }

      if (!recorded) {
        lines.push(
          '',
          'Nobody has recorded what this project is for. Once you know, ' +
            '`note` without a path is where it goes.'
        );
      }

      return {
        text: lines.join('\n'),
        structured: {
          server: args.server,
          root,
          facts,
          narrative: recorded ? recorded.summary : undefined,
          detail: recorded ? recorded.detail : undefined,
          recorded: recorded ? recorded.updated : undefined,
          stale: recorded ? recorded.stale : undefined,
        },
      };
    },
  };


  /**
   * The editor's local history for the file behind a remote path.
   *
   * Everything else here answers with one of two versions: what the server has
   * and what is on disk now. The interesting question is usually between them
   * - what this looked like before the change being asked about - and the only
   * record of that is the editor's.
   */
  async function historyOf(
    service: ServiceLike,
    remotePath: string
  ): Promise<{ versions: Older[]; localPath: string }> {
    const localPath = (context.localPathFor || localPathFor)(service, remotePath);
    const root = context.historyRoot ? context.historyRoot() : undefined;
    const versions: Older[] = [];

    if (root) {
      const uri = context.uriFor ? context.uriFor(localPath) : `file://${localPath}`;
      (await versionsFor(root, uri)).forEach(version =>
        versions.push({
          id: version.id,
          timestamp: version.timestamp,
          source: version.source || 'saved in the editor',
          read: () =>
            contentOf(root, version).then(text =>
              text === undefined ? undefined : text
            ),
        })
      );
    }

    // The two are answers to one question - what was here before - so they are
    // one list. Which mechanism happened to catch a version is not something
    // the caller should have to know about.
    if (context.replacedVersions) {
      (await context.replacedVersions(service, localPath)).forEach(version =>
        versions.push({
          id: `replaced:${version.id}`,
          timestamp: version.timestamp,
          source: 'replaced by a download',
          read: () => version.read().catch(() => undefined),
        })
      );
    }

    return {
      versions: versions.sort((a, b) => b.timestamp - a.timestamp),
      localPath,
    };
  }

  interface Older {
    id: string;
    timestamp: number;
    source?: string;
    read(): Promise<string | undefined>;
  }

  function describeVersion(version: Older, at: number): string {
    const when = new Date(version.timestamp).toISOString();
    const why = version.source ? ` (${version.source})` : '';

    return `  ${at}: ${version.id} — ${when}, ${describeVersionAge(
      version.timestamp
    )}${why}`;
  }

  /** A version named by its id, or by its position in the list. */
  function pickVersion(versions: Older[], wanted: any): Older | undefined {
    if (typeof wanted === 'number' || /^\d+$/.test(String(wanted))) {
      return versions[parseInt(String(wanted), 10)];
    }

    return versions.find(version => version.id === String(wanted));
  }

  const NO_HISTORY =
    'There are no earlier versions of this file. They come from two places: ' +
    'the editor\u2019s local history, which covers files saved in this editor on ' +
    'this machine (see workbench.localHistory.enabled), and copies kept when ' +
    'a download wrote over a local file that differed from the server\u2019s.';

  const history: ToolDefinition = {
    name: 'history',
    title: 'Earlier versions of a file',
    description:
      'What a file looked like before it was last saved, from the editor\u2019s ' +
      'own local history. Use it to see how the working copy got to where it ' +
      'is - nothing else here knows that. Lists the versions, or returns one ' +
      'of them when you name it.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        path: { type: 'string', description: 'Absolute remote path.' },
        version: {
          type: 'string',
          description:
            'A version id from the listing, or its position (0 is the most ' +
            'recent). Returns that version\u2019s contents.',
        },
        start_line: { type: 'integer', description: 'First line, 1-based.' },
        end_line: { type: 'integer', description: 'Last line, inclusive.' },
      },
      required: ['server', 'path'],
    },
    outputSchema: objectSchema({
      path: stringField,
      localPath: stringField,
      versions: {
        type: 'array',
        items: objectSchema({
          index: numberField,
          id: stringField,
          timestamp: numberField,
          source: stringField,
        }),
      },
      version: stringField,
      timestamp: numberField,
      content: stringField,
      redacted: { type: 'array', items: stringField },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }
      if (typeof args.path !== 'string' || args.path === '') {
        return errorResult('A path is required.');
      }

      const target = within(service, args.path);
      if (!target) {
        return outside(service, args.path);
      }
      if (isDenied(target, context.deniedFiles ? context.deniedFiles() : [])) {
        return errorResult(deniedMessage(target));
      }

      const { versions, localPath } = await historyOf(service, target);
      if (versions.length === 0) {
        return {
          text: NO_HISTORY,
          structured: { path: target, localPath, versions: [] },
        };
      }

      if (args.version === undefined) {
        return {
          text:
            `${versions.length} earlier version${
              versions.length === 1 ? '' : 's'
            } of ${localPath}, newest first:\n` +
            versions.map((version, at) => describeVersion(version, at)).join('\n') +
            '\n\nName one as version to read it, or compare it with the server ' +
            'using diff.',
          structured: {
            path: target,
            localPath,
            versions: versions.map((version, at) => ({
              index: at,
              id: version.id,
              timestamp: version.timestamp,
              source: version.source,
            })),
          },
        };
      }

      const wanted = pickVersion(versions, args.version);
      if (!wanted) {
        return errorResult(
          `There is no version ${args.version} of ${target}. Call this without ` +
            'a version to see which there are.'
        );
      }

      const raw = await wanted.read();
      if (raw === undefined) {
        return errorResult(
          `The editor no longer has the contents of version ${wanted.id}.`
        );
      }

      const scrubbed = redact(raw, redaction());
      const body = sliceLines(scrubbed.text, args.start_line, args.end_line);
      const note = redactionNote(scrubbed.found, scrubbed.secrets.length);

      return {
        text:
          `${localPath} as it was ${describeVersionAge(wanted.timestamp)} ` +
          `(${new Date(wanted.timestamp).toISOString()})\n` +
          (note ? `${note}\n` : '') +
          '\n' +
          body,
        structured: {
          path: target,
          localPath,
          version: wanted.id,
          timestamp: wanted.timestamp,
          content: body,
          redacted: scrubbed.found,
        },
      };
    },
  };

  /**
   * Any two of the three versions of a file that exist: the server's, the one
   * on disk, and whichever earlier one the editor still holds.
   */
  /**
   * The same file on a different connection.
   *
   * Two servers hosting the same project mount it at different roots, so
   * “the same file” is the same path *below* the root, not the same absolute
   * path. Resolving through the other connection's root also means the
   * boundary is checked again on that side: a path that is inside one
   * connection has no standing in another.
   */
  function counterpart(
    from: ServiceLike,
    to: ServiceLike,
    remotePath: string
  ): string | undefined {
    const relative = upath.relative(from.getConfig().remotePath, remotePath);

    return relative === '' || relative.indexOf('..') === 0
      ? undefined
      : resolveWithin(to.getConfig().remotePath, relative);
  }

  async function readFromServer(
    service: ServiceLike,
    remotePath: string,
    label: string
  ): Promise<{ text?: string; label: string; error?: string }> {
    if (isDenied(remotePath, context.deniedFiles ? context.deniedFiles() : [])) {
      return { label, error: deniedMessage(remotePath) };
    }

    const remote = await context.remoteFs(service);
    const looked = await statOrReason(remote, remotePath);
    if (looked.unreachable) {
      return { label, error: looked.unreachable };
    }
    const onServer = looked.stat;
    if (!onServer) {
      return { label, error: `${remotePath} is not on ${label}.` };
    }
    if (onServer.size > sizeLimit()) {
      return {
        label,
        error:
          `${remotePath} is too large to compare ` +
          `(${describeSize(onServer.size)}).`,
      };
    }

    const bytes = await remote.readFile(remotePath);

    return {
      label,
      text: Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes),
    };
  }

  async function sideOf(
    service: ServiceLike,
    remotePath: string,
    which: string
  ): Promise<{ text?: string; label: string; error?: string }> {
    const label = which;

    if (which === 'remote') {
      return readFromServer(service, remotePath, 'server');
    }

    // `server:<id>`: the same file as another connection has it, which is how
    // “what differs between staging and production” gets asked.
    if (which.indexOf('server:') === 0) {
      const other = resolve(which.slice('server:'.length));
      if (!other) {
        return { label, error: UNKNOWN_SERVER };
      }

      const there = counterpart(service, other, remotePath);
      if (!there) {
        return {
          label,
          error:
            `${remotePath} has no counterpart on ${other.name}: it is not ` +
            'below the root that connection exposes.',
        };
      }

      return readFromServer(other, there, `${other.name} (${there})`);
    }

    if (which === 'local') {
      const localPath = (context.localPathFor || localPathFor)(service, remotePath);
      try {
        return { label: 'working copy', text: await fse.readFile(localPath, 'utf8') };
      } catch (error) {
        return { label, error: `There is no local copy of ${remotePath}.` };
      }
    }

    const { versions } = await historyOf(service, remotePath);
    const wanted = pickVersion(versions, which);
    if (!wanted) {
      return { label, error: `There is no version ${which} of ${remotePath}.` };
    }

    const text = await wanted.read();
    if (text === undefined) {
      return { label, error: `The editor no longer has version ${wanted.id}.` };
    }

    // Named as well as dated: comparing two versions of the same file the same
    // afternoon otherwise labels both sides identically.
    return {
      label:
        `version ${wanted.id} from ${describeVersionAge(wanted.timestamp)} ` +
        `(${new Date(wanted.timestamp).toISOString().slice(0, 16).replace('T', ' ')})`,
      text,
    };
  }

  const diffTool: ToolDefinition = {
    name: 'diff',
    title: 'Compare two versions',
    description:
      'A unified diff between any two of: the file on the server, the copy on ' +
      'this machine, an earlier version from history, and the same file ' +
      'on another connection ("server:<id>"). Answers \u201cwhat changed\u201d and ' +
      '\u201cwhat differs between staging and production\u201d directly, instead of ' +
      'making you read both files.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'An id or name from `servers`.' },
        path: { type: 'string', description: 'Absolute remote path.' },
        left: {
          type: 'string',
          description:
            'The older side: "remote", "local", a version id or index from ' +
            'history, or "server:<id>" for the same file on another ' +
            'connection. Defaults to "remote".',
        },
        right: {
          type: 'string',
          description: 'The newer side, same values. Defaults to "local".',
        },
      },
      required: ['server', 'path'],
    },
    outputSchema: objectSchema({
      path: stringField,
      changed: booleanField,
      left: stringField,
      right: stringField,
      added: numberField,
      removed: numberField,
      summarised: booleanField,
      diff: stringField,
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args: any) {
      const service = resolve(args.server);
      if (!service) {
        return errorResult(UNKNOWN_SERVER);
      }
      if (typeof args.path !== 'string' || args.path === '') {
        return errorResult('A path is required.');
      }

      const target = within(service, args.path);
      if (!target) {
        return outside(service, args.path);
      }
      if (isDenied(target, context.deniedFiles ? context.deniedFiles() : [])) {
        return errorResult(deniedMessage(target));
      }

      const leftWanted = args.left === undefined ? 'remote' : String(args.left);
      const rightWanted = args.right === undefined ? 'local' : String(args.right);

      const [left, right] = await Promise.all([
        sideOf(service, target, leftWanted),
        sideOf(service, target, rightWanted),
      ]);

      if (left.error || right.error) {
        return errorResult(left.error || right.error!);
      }

      // Both sides are scrubbed before they are compared, so a credential
      // cannot leak through a diff that read would have hidden. A
      // credential that *changed* therefore shows as no change at all, which
      // is worth saying out loud.
      const leftClean = redact(left.text!, redaction());
      const rightClean = redact(right.text!, redaction());
      const result = diffOf(leftClean.text, rightClean.text);

      const found = leftClean.found.concat(rightClean.found);
      const caveat =
        found.length > 0
          ? '\nCredentials were replaced on both sides before comparing, so a ' +
            'change to one of them does not show here.'
          : '';

      if (!result.changed) {
        return {
          text: `${target}: the ${left.label} and the ${right.label} are identical.${caveat}`,
          structured: { path: target, changed: false, left: left.label, right: right.label },
        };
      }

      return {
        text:
          `${target}\n--- ${left.label}\n+++ ${right.label}\n` +
          `${result.added} added, ${result.removed} removed.${caveat}\n\n` +
          result.text,
        structured: {
          path: target,
          changed: true,
          left: left.label,
          right: right.label,
          added: result.added,
          removed: result.removed,
          summarised: result.summarised,
          diff: result.text,
        },
      };
    },
  };

  return [
    servers,
    list,
    stat,
    fetch,
    fetchLocal,
    search,
    tree,
    history,
    diffTool,
    recordNote,
    forgetNotes,
    overview,
  ];
}

function describeConnectionLine(
  connection: ExposedConnection & { summary?: string }
): string {
  const who = connection.username ? `${connection.username}@` : '';
  const profile = connection.profile ? ` [profile: ${connection.profile}]` : '';

  return (
    `${connection.id}  ${connection.name}${profile}\n` +
    `    ${connection.protocol}://${who}${connection.host}:${connection.port}` +
    `${connection.remotePath}\n` +
    `    project: ${connection.workspace}` +
    (connection.summary ? `\n    ${connection.summary}` : '')
  );
}

/** What a version of a file is, for a note that describes it. */
function hashOf(content: string | Buffer): string {
  return crypto
    .createHash('sha1')
    .update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    .digest('hex');
}

/**
 * Files below this are not worth a line of description: a two-line include or
 * a stub tells you what it is from its name.
 */
const WORTH_DESCRIBING = 2000;

/**
 * How long a description may be.
 *
 * A file's appears on its line in `tree`, beside eight hundred others, so it
 * has to stay a line: a paragraph there costs more attention than it repays,
 * and a tree of paragraphs is the thing nobody reads. A project's is read on
 * its own, in `overview` and in the listing, so it can afford a few sentences.
 *
 * Refused rather than truncated. Half a description reads like a whole one
 * and says something else.
 */
const LONGEST_SUMMARY = 200;
const LONGEST_DETAIL = 2000;

/**
 * Asked once per file per window, so a second read of the same file is not a
 * second request. Bounded by the files actually read.
 */
const alreadyAsked: { [key: string]: true } = Object.create(null);

/**
 * Nudging where the understanding is.
 *
 * Notes only pay for themselves if they get written, and nothing was writing
 * them: the one prompt lived in `tree`, which is where you go *before* you
 * understand anything. This asks at the moment a file has just been read and
 * has no description - and only then, and only once.
 */
function askForANote(
  connectionId: string,
  remotePath: string,
  described: { state: NoteState },
  size: number
): string {
  if (size < WORTH_DESCRIBING) {
    return '';
  }

  // Keyed by the state as well: a file asked about while it had no note is
  // worth asking about again once its note has gone stale.
  const key = `${connectionId}|${remotePath}|${described.state}`;
  if (alreadyAsked[key]) {
    return '';
  }
  alreadyAsked[key] = true;

  // Nothing ever rewrites a note by itself - an inferred description of a file
  // nobody read is a guess, and a confident wrong summary is worse than none.
  // What a changed file gets is this, at the moment somebody has just read it.
  if (described.state === NoteState.Stale) {
    return (
      'The description above is of an older version of this file. You have ' +
      'just read the current one: if it no longer fits, `note` replaces it - ' +
      'keeping whatever is still true of it.'
    );
  }

  // A file does not have to change for what is known about it to. The first
  // description is written from one reading of a file for one purpose; the
  // second time somebody reads it they are there for something else, and know
  // something that line does not say.
  if (described.state === NoteState.Current) {
    return (
      'That description was written by whoever read this file before you, ' +
      'for whatever they were reading it for. If your reading has shown you ' +
      'something it does not say, `note` replaces the line - keep what still ' +
      'holds and add what it misses, rather than writing it from your angle ' +
      'alone. What it replaces is kept either way.'
    );
  }

  return (
    'Nothing describes this file yet. If you now know what it is for, ' +
    '`note` takes one line and puts it in every `tree` from here on - for ' +
    'you next time, or for whoever reads this server next.'
  );
}

/** For tests, and for a window that has been open long enough to forget. */
export function forgetWhatWasAsked(): void {
  Object.keys(alreadyAsked).forEach(key => delete alreadyAsked[key]);
}

function clamp(value: any, fallback: number, max: number): number {
  const asked = typeof value === 'number' && !isNaN(value) ? value : fallback;
  return Math.max(0, Math.min(max, Math.round(asked)));
}

/**
 * Why a walk stopped, in the words of what to do about it.
 *
 * The three limits have nothing in common but the fact that they cut the
 * listing short: one wants a bigger number, one wants a smaller question, and
 * one wants to be asked again. A single sentence covering all three told the
 * reader only that something was missing.
 */
function limitsOf(found: { stoppedBy: WalkLimit[] }, asked: number): string {
  const said: string[] = [];

  if (found.stoppedBy.indexOf('files') !== -1) {
    said.push('the file limit was reached, so narrow it with dir');
  }
  if (found.stoppedBy.indexOf('time') !== -1) {
    said.push('it ran out of time, so ask again or narrow it with dir');
  }
  if (found.stoppedBy.indexOf('depth') !== -1) {
    said.push(
      `there are directories below depth ${asked}, so raise depth to see them`
    );
  }

  return said.join('; ') || 'a limit was reached';
}

function describeSearch(
  matches: Match[],
  paths: { path: string }[],
  about: {
    root: string;
    scanned: number;
    fetched: number;
    skipped?: number;
    failed?: number;
    outOfTime?: boolean;
    nextOffset?: number;
    walk: WalkResult;
    depth: number;
    more: boolean;
  }
): string {
  const lines: string[] = [];

  // Every result says what it had to do, so the cost is never invisible.
  lines.push(
    `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${about.root} ` +
      `(${about.scanned} files searched, ${about.fetched} fetched from the server).`
  );
  if (about.failed) {
    // Said even when there were matches: a partial search that looks complete
    // is how somebody concludes a string is absent from a file nobody read.
    lines.push(
      `${about.failed} file${about.failed === 1 ? '' : 's'} could not be read ` +
        'and were not searched.'
    );
  }
  if (about.skipped) {
    lines.push(
      `${about.skipped} file${about.skipped === 1 ? ' was' : 's were'} skipped ` +
        'as too large or not text.'
    );
  }
  if (about.outOfTime) {
    lines.push('The search ran out of time before every file was read.');
  }
  if (about.walk && about.walk.truncated) {
    lines.push(`Not every file was listed: ${limitsOf(about.walk, about.depth)}.`);
  }
  if (about.more) {
    lines.push('More matches exist; raise max_matches to see them.');
  }
  if (about.nextOffset !== undefined) {
    // The files it did not reach are still there to be searched, and saying
    // where it stopped is more use than telling it to ask a smaller question.
    lines.push(
      `Files after this one were not searched. Call again with offset: ` +
        `${about.nextOffset} to carry on from where this stopped.`
    );
  }

  if (paths.length > 0) {
    lines.push('', 'Paths matching the query:');
    paths.slice(0, 20).forEach(file => lines.push(`  ${file.path}`));
  }

  if (matches.length > 0) {
    lines.push('', 'In file contents:');
    matches.forEach(match => {
      (match.before || []).forEach(line => lines.push(`  ${match.path}-      ${line}`));
      lines.push(`  ${match.path}:${match.line}: ${match.text}`);
      (match.after || []).forEach(line => lines.push(`  ${match.path}-      ${line}`));
    });
  }

  return lines.join('\n');
}

function byDirectoryThenName(a: FileEntry, b: FileEntry): number {
  const aDir = a.type === FileType.Directory ? 0 : 1;
  const bDir = b.type === FileType.Directory ? 0 : 1;
  return aDir - bDir || a.name.localeCompare(b.name);
}
