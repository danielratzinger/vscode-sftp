import * as path from 'path';
import { Uri, window } from 'vscode';
import { FileType } from '../core';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerItem } from '../modules/remoteExplorer';
import { executeCommand, getActiveTextEditor } from '../host';
import { listFiles, toLocalPath, simplifyPath } from '../helper';

function configIngoreFilterCreator(config) {
  if (!config || !config.ignore) {
    return;
  }

  return file => !config.ignore(file.fsPath);
}

function createFileSelector(filterCreator?) {
  return async (): Promise<Uri | undefined> => {
    const remoteItems = getAllFileService().map((fileService, index) => {
      const config = fileService.getConfig();
      return {
        name: config.name || config.remotePath,
        description: config.host,
        fsPath: config.remotePath,
        type: FileType.Directory,
        filter: filterCreator ? filterCreator(config) : undefined,
        getFs: () => fileService.getRemoteFileSystem(config),
        index,
        remoteBaseDir: config.remotePath,
        baseDir: fileService.baseDir,
      };
    });

    const selected = await listFiles(remoteItems);

    if (!selected) {
      return;
    }

    const rootItem = remoteItems[selected.index];
    const localTarget = toLocalPath(selected.fsPath, rootItem.remoteBaseDir, rootItem.baseDir);

    return Uri.file(localTarget);
  };
}

export function selectContext(): Promise<Uri | undefined> {
  return new Promise((resolve, reject) => {
    const sercives = getAllFileService();
    const projectsList = sercives
      .map(service => ({
        value: service.baseDir,
        label: service.name || simplifyPath(service.baseDir),
        description: '',
        detail: service.baseDir,
      }))
      .sort((l, r) => l.label.localeCompare(r.label));

    // if (projectsList.length === 1) {
    // return resolve(projectsList[0].value);
    // }

    window
      .showQuickPick(projectsList, {
        placeHolder: 'Select a folder...',
      })
      .then(selection => {
        if (selection) {
          return resolve(Uri.file(selection.value));
        }

        // cancel selection
        resolve();
      }, reject);
  });
}

export function applySelector<T>(...selectors: ((...args: any[]) => T | Promise<T>)[]) {
  return function combinedSelector(...args: any[]): T | Promise<T> {
    let result;
    for (const selector of selectors) {
      result = selector.apply(this, args);
      if (result) {
        break;
      }
    }

    return result;
  };
}

export function uriFromfspath(fileList: string[]): Uri[] | undefined {
  if (!Array.isArray(fileList) || typeof fileList[0] !== 'string') {
    return;
  }

  return fileList.map(file => Uri.file(file));
}

export function getActiveDocumentUri() {
  const active = getActiveTextEditor();
  if (!active || !active.document) {
    return;
  }

  return active.document.uri;
}

export function getActiveFolder() {
  const uri = getActiveDocumentUri();
  if (!uri) {
    return;
  }

  return Uri.file(path.dirname(uri.fsPath));
}

// selected file or activeTarget or configContext
export function uriFromExplorerContextOrEditorContext(item, items): undefined | Uri | Uri[] {
  // from explorer or editor context
  if (item instanceof Uri) {
    if (Array.isArray(items) && items[0] instanceof Uri) {
      // multi-select in explorer
      return items;
    } else {
      return item;
    }
  } else if ((item as ExplorerItem).resource) {
    // from remote explorer
    if (Array.isArray(items) && (items[0] as ExplorerItem).resource) {
      // multi-select in remote explorer
      return items.map(_ => _.resource.uri);
    } else {
      return item.resource.uri;
    }
  }

  return;
}

// selected folder or configContext
export function selectFolderFallbackToConfigContext(item, items): Promise<undefined | Uri | Uri[]> {
  // from explorer or editor context
  if (item) {
    if (item instanceof Uri) {
      if (Array.isArray(items) && items[0] instanceof Uri) {
        // multi-select in explorer
        return Promise.resolve(items);
      } else {
        return Promise.resolve(item);
      }
    } else if ((item as ExplorerItem).resource) {
      // from remote explorer
      return Promise.resolve(item.resource.uri);
    }
  }

  return selectContext();
}

// selected file from all remote files
export const selectFileFromAll = createFileSelector();

// selected file from remote files expect ignored
export const selectFile = createFileSelector(configIngoreFilterCreator);

/**
 * Showing the local copy of a remote file in the system's file manager.
 *
 * `Reveal in Explorer` shows it in the editor's own sidebar; this opens
 * Finder, or whatever the file manager is where this is running, which is
 * where you go for what the editor does not do - a Quick Look, a drag into
 * another application, a look at what else is in the folder.
 *
 * `revealFileInOS` is the editor's own command for it, so the behaviour is the
 * platform's rather than ours.
 */
export async function revealLocal(ctx: {
  target: { localUri: Uri };
}): Promise<void> {
  await executeCommand('revealFileInOS', ctx.target.localUri);
}

/**
 * Opening a folder in the machine's own terminal, not the editor's.
 *
 * `openInTerminal` is the editor's command for the external one and
 * `openInIntegratedTerminal` for the built-in - two ids, so this is not the
 * setting that decides which of them the editor offers in its own menus. It
 * honours `terminal.external.*Exec`, so whatever somebody has set as their
 * terminal is the one that opens.
 */
export async function revealInTerminal(ctx: {
  target: { localUri: Uri };
}): Promise<void> {
  await executeCommand('openInTerminal', ctx.target.localUri);
}
