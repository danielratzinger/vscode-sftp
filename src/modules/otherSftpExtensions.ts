import * as vscode from 'vscode';
import logger from '../logger';

/**
 * Noticing when another SFTP extension is running alongside this one.
 *
 * There is nothing to import from it. Every setting either extension reads is
 * `sftp.*` in the editor's own settings, or `.vscode/sftp.json` in the
 * project - files, not extension storage - so this fork picks up an existing
 * configuration with no migration at all. Nothing is stored under an
 * extension id that the other one would miss.
 *
 * What does matter is both being *enabled*. They register the same command
 * ids, watch the same files and answer the same `uploadOnSave`, so a save
 * uploads twice and a command runs in whichever one the editor picked. That
 * fails quietly, which is why it is worth saying out loud once.
 */

/** Extensions that claim the same commands and act on the same files. */
export const RIVALS = [
  { id: 'Natizyskunk.sftp', name: 'SFTP (Natizyskunk)' },
  { id: 'liximomo.sftp', name: 'SFTP (liximomo)' },
  { id: 'satiromarra.code-sftp', name: 'code-sftp (satiromarra)' },
];

const ASKED = 'sftp.conflictWarningDismissed';

/**
 * Which of them are active. A disabled extension is not returned by
 * `getExtension`, which is exactly the question being asked: an installed but
 * disabled one is harmless and must not be nagged about.
 */
export function activeRivals(
  lookup: (id: string) => any
): Array<{ id: string; name: string }> {
  return RIVALS.filter(rival => Boolean(lookup(rival.id)));
}

export function conflictMessage(found: Array<{ name: string }>): string {
  const names = found.map(rival => rival.name).join(' and ');

  return (
    `${names} ${found.length === 1 ? 'is' : 'are'} enabled alongside this ` +
    'one. Both answer the same commands and the same uploadOnSave, so a save ' +
    'can upload twice. Your configuration is shared, so disabling the other ' +
    'one changes nothing about your servers.'
  );
}

export function checkForOtherSftpExtensions(
  context: vscode.ExtensionContext
): void {
  const state: any = context.globalState;
  if (state && state.get && state.get(ASKED) === true) {
    return;
  }

  const found = activeRivals(id => vscode.extensions.getExtension(id));
  if (found.length === 0) {
    return;
  }

  logger.info(
    `[startup] another SFTP extension is enabled: ${found
      .map(rival => rival.id)
      .join(', ')}`
  );

  vscode.window
    .showWarningMessage(
      conflictMessage(found),
      'Manage Extensions',
      'Keep Both',
      'Don’t Show Again'
    )
    .then(answer => {
      if (answer === 'Manage Extensions') {
        // Opens the other extension's page, where Disable is.
        vscode.commands
          .executeCommand('extension.open', found[0].id)
          .then(undefined, () =>
            vscode.commands.executeCommand(
              'workbench.extensions.search',
              '@installed sftp'
            )
          );
        return;
      }

      if (answer === 'Don’t Show Again' && state && state.update) {
        state.update(ASKED, true);
      }
    });
}
