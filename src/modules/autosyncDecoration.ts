import * as vscode from 'vscode';
import { UResource } from '../core';
import { getAllFileService } from './serviceManager';
import {
  AutosyncState,
  autosyncState,
  onDidChangeAutosync,
} from './worktreeSync';

/**
 * Saying, in both explorers, which projects are being autosynced - and from
 * where, because those are two different situations.
 *
 * Syncing the folder this window has open is the ordinary case: your saves
 * still reach the server, they just go up when they have settled. Syncing a
 * checkout that is not open here is not ordinary at all - this window's saves
 * are standing down, and what reaches the server is whatever an agent is
 * writing somewhere else. Both deserve a mark; they do not deserve the same
 * one, because the second is a thing you can forget and then be surprised by.
 *
 * So: a badge either way, a second character and a warning colour when the
 * folder is elsewhere, and a tooltip that names it.
 *
 * A decoration rather than a label: the editor puts it on the folder in the
 * file explorer and on the connection in the Remote Explorer, in whatever way
 * the current theme does that, and takes it away again when the sync stops.
 */

/** Syncing the folder this window has open. */
const HERE = '⟳';

/** Syncing a checkout that is not open here: the work is coming from away. */
const ELSEWHERE = '↗';

class AutosyncDecorations implements vscode.FileDecorationProvider {
  private _changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._changed.event;

  refresh(): void {
    this._changed.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    for (const service of getAllFileService()) {
      const state = autosyncState(service);
      if (!state) {
        continue;
      }

      if (this._isThisConnection(service, state, uri)) {
        return state.external
          ? {
              badge: ELSEWHERE,
              tooltip: `Autosyncing ${state.label} from ${state.root} — this window's saves are paused`,
              // The colour a list uses for "look at this": the window is not
              // doing what it normally does.
              color: new vscode.ThemeColor('list.warningForeground'),
            }
          : {
              badge: HERE,
              tooltip: `Autosyncing this folder (${state.label})`,
              // The colour themes use for "this has changed", which is what
              // is happening to it.
              color: new vscode.ThemeColor(
                'gitDecoration.modifiedResourceForeground'
              ),
            };
      }
    }

    return undefined;
  }

  /**
   * Whether this is how that connection appears - the project folder in the
   * file explorer, the connection's root in the Remote Explorer, or the folder
   * being autosynced wherever it is.
   */
  private _isThisConnection(
    service: any,
    state: AutosyncState,
    uri: vscode.Uri
  ): boolean {
    if (UResource.isRemote(uri)) {
      const config = service.getConfig();
      const resource = UResource.makeResource(uri);
      return (
        uri.authority.indexOf(config.host) === 0 &&
        resource.fsPath === config.remotePath
      );
    }

    return uri.fsPath === service.baseDir || uri.fsPath === state.root;
  }
}

export default function initAutosyncDecoration(
  context: vscode.ExtensionContext
): void {
  const decorations = new AutosyncDecorations();

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorations),
    onDidChangeAutosync(() => decorations.refresh())
  );
}
