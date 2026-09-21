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

/** Watching the folder this window has open, with nothing to send. */
const HERE = '⟳';

/** Watching a checkout that is not open here: the work is coming from away. */
const ELSEWHERE = '↗';

/**
 * Nothing here changes while a file is on its way up.
 *
 * The mark means "this folder is being deployed", and that is true of the
 * minute between uploads as much as of the second during one. A colour that
 * came and went with each transfer would be answering a question nobody asked
 * - what matters is whether it is on, which is the same question as whether
 * `Stop Autosync` would do anything.
 */

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
        // A real `FileDecoration`, not an object that looks like one: the
        // editor reads these across a process boundary, and the class is what
        // the conversion on the other side is written against.
        // One colour, because the colour answers one question: is autosync on.
        // Which folder it is deploying is what the badge and the tooltip are
        // for. A second colour here meant a project deploying an agent's
        // checkout looked like a warning, and sat among the folders git had
        // already coloured for its own reasons.
        const on = new vscode.ThemeColor('notificationsInfoIcon.foreground');

        return state.external
          ? new vscode.FileDecoration(
              ELSEWHERE,
              `Autosync is on, deploying ${state.root} — this window's saves are paused`,
              on
            )
          : new vscode.FileDecoration(
              HERE,
              `Autosync is on for this folder (${state.label})`,
              on
            );
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
