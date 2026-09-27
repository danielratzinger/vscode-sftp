import { Uri, window } from 'vscode';
import { upath } from '../core';
import { handleCtxFromUri } from '../fileHandlers';
import { uriFromExplorerContextOrEditorContext } from './shared';
import { showWarningMessage } from '../host';

/**
 * Asking where a download should go, when it should not go where it usually
 * goes.
 *
 * The place this connection maps it to is offered as the answer, since that is
 * what somebody is deviating from and the name is usually most of what they
 * want to keep.
 */
export async function askWhereToPut(
  item: any,
  items: any,
  what: 'file' | 'folder'
): Promise<{ from: Uri; to: string } | undefined> {
  const target = uriFromExplorerContextOrEditorContext(item, items);
  if (!target) {
    return undefined;
  }

  if (Array.isArray(target) && target.length > 1) {
    // One destination for several things is not one destination.
    showWarningMessage(`Downloading to a chosen place works on one ${what} at a time.`);
    return undefined;
  }

  const from: Uri = Array.isArray(target) ? target[0] : target;
  const ctx = handleCtxFromUri(from);

  const chosen = await window.showSaveDialog({
    defaultUri: Uri.file(ctx.target.localFsPath),
    saveLabel: what === 'folder' ? 'Download Folder Here' : 'Download',
    title: `Download '${upath.basename(from.path)}' as`,
  });

  if (!chosen) {
    return undefined;
  }

  return { from, to: chosen.fsPath };
}
