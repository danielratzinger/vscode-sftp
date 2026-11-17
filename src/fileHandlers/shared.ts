import { UResource, FileService, FileType } from '../core';
import app from '../app';

// NEED_VSCODE_UPDATE: detect explorer view visible
// refresh will open explorer view which cause a problem https://github.com/liximomo/vscode-sftp/issues/286
// export function refreshLocalExplorer(localUri: Uri) {
//   // do nothing
// }

export async function refreshRemoteExplorer(target: UResource, isDirectory: FileService | boolean) {
  if (isDirectory instanceof FileService) {
    const fileService = isDirectory;
    const localFs = fileService.getLocalFileSystem();
    const fileEntry = await localFs.lstat(target.localFsPath);
    isDirectory = fileEntry.type === FileType.Directory;
  }

  app.remoteExplorer.refresh({
    resource: UResource.makeResource(target.remoteUri),
    isDirectory,
  });
}

/**
 * The rows a download may just have given their first local copy.
 *
 * What a row offers - `Reveal in Finder`, `Reveal in Terminal` - is decided
 * when it is drawn, by whether there is anything on this machine for it. A
 * download changes that, and nothing drew the row again: the file or folder
 * just brought down went on offering nothing to reveal until the tree was
 * refreshed by hand. So the folder it is in is redrawn, which redraws its row,
 * and a folder's own row and listing are as well - a folder brought down
 * deep in the tree may be the first local copy of the folders above it, and
 * the one it is in is the nearest of them.
 *
 * Never throws: it runs after the transfer is over, with nobody waiting, and
 * a download that was declined has nothing on this machine to look at.
 */
export async function refreshAfterDownload(target: UResource, fileService: FileService) {
  if (!app.remoteExplorer) {
    return;
  }

  try {
    const entry = await fileService.getLocalFileSystem().lstat(target.localFsPath);
    const resource = UResource.makeResource(target.remoteUri);

    app.remoteExplorer.refresh({ resource, isDirectory: false });
    if (entry.type === FileType.Directory) {
      app.remoteExplorer.refresh({ resource, isDirectory: true });
    }
  } catch (error) {
    // Nothing came down.
  }
}

