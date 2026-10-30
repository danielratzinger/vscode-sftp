import * as vscode from 'vscode';
import logger from '../logger';
import { setContextValue } from '../host';
import { ignoreRulesFor } from '../core/projectIgnore';
import { getAllFileService } from './serviceManager';

/**
 * `sftp.hasIgnoreRules`: whether any connection here has something that says
 * what not to deploy - a `.gitignore`, a `.git-ftp-ignore`, or an `ignore` in
 * its `sftp.json`. `Upload Folder in Full` and `Remove ignored files from
 * Remote` are offered only then; without any, they would mean nothing.
 *
 * Asked again when one of those files comes or goes, and when a `sftp.json`
 * is saved, since that is when connections are built again.
 */

export async function refreshIgnoreContext(): Promise<void> {
  let any = false;
  for (const service of getAllFileService()) {
    // Built from `ignore` and `ignoreFile` together, and null with neither.
    if (service.getConfig().ignore) {
      any = true;
      break;
    }
    if (await ignoreRulesFor(service.baseDir).catch(() => undefined)) {
      any = true;
      break;
    }
  }
  setContextValue('hasIgnoreRules', any);
}

function refreshQuietly() {
  refreshIgnoreContext().catch(error =>
    logger.debug(`could not tell whether there are ignore rules: ${error.message}`)
  );
}

export function initIgnoreContext(context: vscode.ExtensionContext): void {
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.gitignore,.git-ftp-ignore}');
  watcher.onDidCreate(refreshQuietly);
  watcher.onDidDelete(refreshQuietly);
  context.subscriptions.push(watcher);
  refreshQuietly();
}
