import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { showTextDocument } from '../../host';
import { isSubpathOf, toLocalPath } from '../../helper';
import {
  upath,
  UResource,
  Resource,
  FileService,
  FileType,
  FileEntry,
  Ignore,
  ServiceConfig,
} from '../../core';
import {
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
  COMMAND_REMOTEEXPLORER_EDITINLOCAL,
} from '../../constants';
import { getAllFileService } from '../serviceManager';
import { autosyncState } from '../worktreeSync';
import { getExtensionSetting } from '../ext';

type Id = number;

const previewDocumentPathPrefix = '/~ ';

const DEFAULT_FILES_EXCLUDE = ['.git', '.svn', '.hg', 'CVS', '.DS_Store'];

/** What makes the local copy of a folder a working copy of something. */
const REPOSITORY_MARKERS = ['.git', '.svn', '.hg'];

/**
 * `.git` can be a file rather than a folder, in a worktree or a submodule, so
 * this asks whether the name is there at all.
 */
function holdsARepository(dir: string): boolean {
  return REPOSITORY_MARKERS.some(marker => {
    try {
      return fs.existsSync(path.join(dir, marker));
    } catch (error) {
      return false;
    }
  });
}

/**
 * Whether anything has been downloaded here yet.
 *
 * `Reveal in Finder` has nothing to show without it, and an entry that opens
 * a window on nothing is worse than no entry. Not cached, unlike the walk
 * above: this changes with every download, and it is one question about one
 * path rather than a climb.
 */
export function hasLocalCopy(local: string): boolean {
  try {
    return fs.existsSync(local);
  } catch (error) {
    return false;
  }
}

/**
 * Answers kept for the life of a tree, because this is asked once per visible
 * item and the walk repeats itself all the way up every time.
 */
const repositoryAnswers = new Map<string, boolean>();

export function forgetRepositoryAnswers(): void {
  repositoryAnswers.clear();
}

/**
 * Whether the local copy of this remote folder is in a repository - its own,
 * or one it sits inside.
 *
 * Only `Clear Local Folder` asks. Clearing a folder is for a download that has
 * to start from nothing, and nothing in a working copy is that: the files are
 * tracked, the history is beside them, and what the command would delete is
 * not what a download would put back.
 *
 * The walk stops at the workspace folder. A repository above the folder the
 * editor has open is not this extension's business, and an unbounded walk
 * makes the answer depend on how somebody keeps their home directory.
 */
export function localCopyIsInARepository(local: string, workspace: string): boolean {
  const held = repositoryAnswers.get(local);
  if (held !== undefined) {
    return held;
  }

  const stop = path.resolve(workspace);
  let dir = path.resolve(local);
  let answer = false;

  for (;;) {
    if (holdsARepository(dir)) {
      answer = true;
      break;
    }

    const up = path.dirname(dir);
    if (dir === stop || up === dir || !isSubpathOf(stop, up)) {
      break;
    }
    dir = up;
  }

  repositoryAnswers.set(local, answer);
  return answer;
}
/**
 * covert the url path for a customed docuemnt title
 *
 *  There is no api to custom title.
 *  So we change url path for custom title.
 *  This is not break anything because we get fspth from uri.query.'
 */
function makePreivewUrl(uri: vscode.Uri) {
  // const query = querystring.parse(uri.query);
  // query.originPath = uri.path;
  // query.originQuery = uri.query;

  return uri.with({
    path: previewDocumentPathPrefix + upath.basename(uri.path),
    // query: querystring.stringify(query),
  });
}

interface ExplorerChild {
  resource: Resource;
  isDirectory: boolean;
}

export interface ExplorerRoot extends ExplorerChild {
  explorerContext: {
    fileService: FileService;
    config: ServiceConfig;
    id: Id;
  };
}

export type ExplorerItem = ExplorerRoot | ExplorerChild;

function dirFirstSort(fileA: ExplorerItem, fileB: ExplorerItem) {
  if (fileA.isDirectory === fileB.isDirectory) {
    return fileA.resource.fsPath.localeCompare(fileB.resource.fsPath);
  }

  return fileA.isDirectory ? -1 : 1;
}

export default class RemoteTreeData
  implements vscode.TreeDataProvider<ExplorerItem>, vscode.TextDocumentContentProvider {
  private _roots: ExplorerRoot[] | null;
  private _rootsMap: Map<Id, ExplorerRoot> | null;
  private _map: Map<vscode.Uri['query'], ExplorerItem>;

  // `undefined` is how the tree is told to refresh from the roots, which is
  // what `fire()` with no argument meant before the API said so.
  private _onDidChangeFolder: vscode.EventEmitter<
    ExplorerItem | undefined
  > = new vscode.EventEmitter<ExplorerItem | undefined>();
  private _onDidChangeFile: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeTreeData: vscode.Event<
    ExplorerItem | undefined
  > = this._onDidChangeFolder.event;
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChangeFile.event;

  async refresh(item?: ExplorerItem): Promise<any> {
    // A folder can become a repository, or stop being one, between refreshes.
    forgetRepositoryAnswers();

    // refresh root
    if (!item) {
      // clear cache
      this._roots = null;
      this._rootsMap = null;

      this._onDidChangeFolder.fire(undefined);
      return;
    }

    if (item.isDirectory) {
      this._onDidChangeFolder.fire(item);

      // refresh top level files as well
      const children = await this.getChildren(item);
      children
        .filter(i => !i.isDirectory)
        .forEach(i => this._onDidChangeFile.fire(makePreivewUrl(i.resource.uri)));
    } else {
      const parent = await this.getParent(item);
      if (parent) {
        this._onDidChangeFolder.fire(parent);
      }
      this._onDidChangeFile.fire(makePreivewUrl(item.resource.uri));
    }
  }

  getTreeItem(item: ExplorerItem): vscode.TreeItem {
    const isRoot = (item as ExplorerRoot).explorerContext !== undefined;
    let customLabel;
    if (isRoot) {
      customLabel = (item as ExplorerRoot).explorerContext.fileService.name;
    }
    if (!customLabel) {
      customLabel = upath.basename(item.resource.fsPath);
    }
    // What a badge cannot say: which folder it is syncing, and whether that
    // folder is this window's own or one somewhere else entirely.
    const autosync =
      isRoot && autosyncState((item as ExplorerRoot).explorerContext.fileService);

    return {
      label: customLabel,
      description: autosync
        ? `autosync: ${autosync.label}${autosync.external ? ' (elsewhere)' : ''}`
        : undefined,
      resourceUri: item.resource.uri,
      collapsibleState: item.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
      contextValue: this._describe(item, isRoot),
      command: item.isDirectory
        ? undefined
        : {
            command: getExtensionSetting().downloadWhenOpenInRemoteExplorer
              ? COMMAND_REMOTEEXPLORER_EDITINLOCAL
              : COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
            arguments: [item],
            title: 'View Remote Resource',
          },
    };
  }

  /**
   * What the menus match on. `folder` and `root` as before, with `-repo` where
   * the local copy is a working copy - so a `when` clause can name folders
   * exactly, and the ones that are repositories are not among them.
   *
   * Roots also carry whether *that* connection is autosyncing, and whether the
   * folder it is syncing is one this window does not have open. A context key
   * cannot say that: there is one per window, so with twenty-eight connections
   * in a workspace it would label all of them by whatever one of them is
   * doing. `-autosyncaway` contains `-autosync`, so a clause that wants either
   * can ask for the shorter one.
   */
  private _describe(item: ExplorerItem, isRoot: boolean): string {
    const kind = isRoot ? 'root' : item.isDirectory ? 'folder' : 'file';
    const root = this.findRoot(item.resource.uri);
    if (!root) {
      return kind;
    }

    const syncing = isRoot
      ? autosyncState((item as ExplorerRoot).explorerContext.fileService)
      : undefined;
    const autosync = syncing
      ? syncing.external
        ? '-autosyncaway'
        : '-autosync'
      : '';

    const local = toLocalPath(
      item.resource.fsPath,
      root.explorerContext.config.remotePath,
      root.explorerContext.fileService.baseDir
    );

    // `repo` only for the folders a clear could be offered on; `local` for
    // anything at all, because revealing a file is the common case.
    const inRepository =
      kind !== 'file' &&
      localCopyIsInARepository(local, root.explorerContext.fileService.workspace);

    return (
      kind +
      autosync +
      (inRepository ? '-repo' : '') +
      (hasLocalCopy(local) ? '-local' : '')
    );
  }

  async getChildren(item?: ExplorerItem): Promise<ExplorerItem[]> {
    if (!item) {
      return this._getRoots();
    }

    const root = this.findRoot(item.resource.uri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${item.resource.uri}.`);
    }
    const config = root.explorerContext.config;
    const remotefs = await root.explorerContext.fileService.getRemoteFileSystem(config);
    const fileEntries = await remotefs.list(item.resource.fsPath);

    // An explicit `filesExclude` replaces the defaults, so `[]` is the way to
    // see everything the server reports.
    const filesExcludeList: string[] =
      config.remoteExplorer && config.remoteExplorer.filesExclude
        ? config.remoteExplorer.filesExclude
        : DEFAULT_FILES_EXCLUDE;

    const ignore = new Ignore(filesExcludeList);
    function filterFile(file: FileEntry) {
      const relativePath = upath.relative(config.remotePath, file.fspath);
      return !ignore.ignores(relativePath);
    }

    return fileEntries
      .filter(filterFile)
      .map(file => {
        const isDirectory = file.type === FileType.Directory;
        const newResource = UResource.updateResource(item.resource, {
          remotePath: file.fspath,
        });
        const mapItem = this._map.get(newResource.uri.query);
        if (mapItem) {
          return mapItem;
        } else {
          const newItem = {
            resource: UResource.updateResource(item.resource, {
              remotePath: file.fspath,
            }),
            isDirectory,
          };
          this._map.set(newItem.resource.uri.query, newItem);
          return newItem;
        }
      })
      .sort(dirFirstSort);
  }

  async getParent(item: ExplorerChild): Promise<ExplorerItem> {
    const resourceUri = item.resource.uri;
    const root = this.findRoot(resourceUri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${resourceUri}.`);
    }

    if (item.resource.fsPath === root.resource.fsPath) {
      return root;
    }

    const fspath = upath.dirname(item.resource.fsPath);
    const newResource = UResource.updateResource(item.resource, {
      remotePath: fspath,
    });
    const mapItem = this._map.get(newResource.uri.query);
    if (mapItem) {
      return mapItem;
    } else {
      const newMapItem = {
        resource: newResource,
        isDirectory: true,
      };
      this._map.set(newResource.uri.query, newMapItem);
      await this.getChildren(newMapItem);
      return newMapItem;
    }
  }

  findRoot(uri: vscode.Uri): ExplorerRoot | null | undefined {
    if (!this._rootsMap) {
      return null;
    }

    const rootId = UResource.makeResource(uri).remoteId;
    return this._rootsMap.get(rootId);
  }

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<string> {
    const root = this.findRoot(uri);
    if (!root) {
      throw new Error(`Can't find remote for resource ${uri}.`);
    }

    const config = root.explorerContext.config;
    const remotefs = await root.explorerContext.fileService.getRemoteFileSystem(config);
    const buffer = await remotefs.readFile(UResource.makeResource(uri).fsPath);
    return buffer.toString();
  }

  showItem(item: ExplorerItem): void {
    if (item.isDirectory) {
      return;
    }

    showTextDocument(makePreivewUrl(item.resource.uri));
  }

  private _getRoots(): ExplorerRoot[] {
    if (this._roots) {
      return this._roots;
    }

    this._roots = [];
    this._rootsMap = new Map();
    this._map = new Map();
    getAllFileService().forEach(fileService => {
      const config = fileService.getConfig();
      const id = fileService.id;
      const item = {
        resource: UResource.makeResource({
          remote: {
            host: config.host,
            port: config.port,
          },
          fsPath: config.remotePath,
          remoteId: id,
        }),
        isDirectory: true,
        explorerContext: {
          fileService,
          config,
          id,
        },
      };
      this._roots!.push(item);
      this._rootsMap!.set(id, item);
      this._map.set(item.resource.uri.query, item);
    });
    this._roots.sort((a,b) => a.explorerContext.config.remoteExplorer.order - b.explorerContext.config.remoteExplorer.order || a.explorerContext.fileService.name.localeCompare(b.explorerContext.fileService.name));
    return this._roots;
  }
}
