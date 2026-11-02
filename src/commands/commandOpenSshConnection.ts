import * as vscode from 'vscode';
import { COMMAND_OPEN_CONNECTION_IN_TERMINAL } from '../constants';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerItem } from '../modules/remoteExplorer';
import { handleCtxFromUri } from '../fileHandlers';
import { createCredentialResolver } from '../core/credentialResolver';
import { AskpassAnswers, sshCommandLine } from '../core/sshSession';
import { startAskpass } from '../modules/sshAskpass';
import { promptForPassword } from '../host';
import upath from '../core/upath';
import logger from '../logger';
import { checkCommand } from './abstract/createCommand';

const isWindows = process.platform === 'win32';

/** The connection and the folder on the server a session should start in. */
async function chooseTarget(
  item?: vscode.Uri | ExplorerItem
): Promise<{ config: any; remoteDir: string } | undefined> {
  const uri =
    item instanceof vscode.Uri ? item : item && item.resource ? item.resource.uri : undefined;

  if (uri) {
    const ctx = handleCtxFromUri(uri);
    const isFolder =
      item instanceof vscode.Uri
        ? (await vscode.workspace.fs.stat(uri).then(
            stat => stat.type === vscode.FileType.Directory ||
              stat.type === vscode.FileType.Directory + vscode.FileType.SymbolicLink,
            () => true
          ))
        : (item as ExplorerItem).isDirectory;
    const remote = ctx.target.remoteFsPath;
    return { config: ctx.config, remoteDir: isFolder ? remote : upath.dirname(remote) };
  }

  const choices = getAllFileService()
    .map(service => service.getConfig())
    .filter(config => config.protocol === 'sftp')
    .map(config => ({
      label: config.name || config.remotePath,
      description: config.host,
      config,
    }));
  if (choices.length === 0) {
    vscode.window.showInformationMessage('No connection here uses SFTP, so there is no SSH to open.');
    return undefined;
  }

  const chosen =
    choices.length === 1
      ? choices[0]
      : await vscode.window.showQuickPick(choices, { placeHolder: 'Open an SSH session to…' });
  return chosen && { config: chosen.config, remoteDir: chosen.config.remotePath };
}

/**
 * The stored password and passphrase, read the first time `ssh` asks - so a
 * connection that logs in with a key never touches a password manager.
 */
function storedSecrets(config: any) {
  let resolved: Promise<{ password?: string; passphrase?: string }> | undefined;
  const resolve = () => {
    if (!resolved) {
      resolved = createCredentialResolver(config)
        .resolve()
        .catch(error => {
          logger.warn(`[ssh] no stored credentials for ${config.host}: ${error.message}`);
          return {};
        });
    }
    return resolved;
  };
  return {
    password: () => resolve().then(found => found.password),
    passphrase: () => resolve().then(found => found.passphrase),
  };
}

function answersFor(config: any): AskpassAnswers {
  const stored = storedSecrets(config);
  return new AskpassAnswers({
    password: stored.password,
    passphrase: stored.passphrase,
    ask: prompt => promptForPassword(prompt.trim()),
    confirm: async prompt => {
      const yes = 'Connect';
      const answer = await vscode.window.showWarningMessage(
        `SSH to ${config.host}`,
        { modal: true, detail: prompt.trim() },
        yes
      );
      return answer === yes;
    },
  });
}

export default checkCommand({
  id: COMMAND_OPEN_CONNECTION_IN_TERMINAL,

  async handleCommand(item?: vscode.Uri | ExplorerItem) {
    const target = await chooseTarget(item);
    if (!target) {
      return;
    }

    const { config, remoteDir } = target;
    if (config.protocol !== 'sftp') {
      vscode.window.showInformationMessage(
        `${config.name || config.host} connects over ${String(config.protocol).toUpperCase()}, which has no shell to open.`
      );
      return;
    }

    const command = sshCommandLine(config, remoteDir);
    const name = `SSH ${config.name || config.host}`;

    // No `sh`, no askpass: typed into the default shell, as it always was, and
    // asked for a password there.
    if (isWindows) {
      const plain = vscode.window.createTerminal(name);
      plain.sendText(command);
      plain.show();
      return;
    }

    // One set of answers per session, so the stored password goes out once.
    const answers = answersFor(config);
    const session = await startAskpass(prompt => answers.answer(prompt));

    // Run by the terminal, not typed into a shell: nothing lands in a history.
    const terminal = vscode.window.createTerminal({
      name,
      shellPath: '/bin/sh',
      shellArgs: ['-c', `exec ${command}`],
      env: session.env,
    });
    const closed = vscode.window.onDidCloseTerminal(gone => {
      if (gone === terminal) {
        session.dispose();
        closed.dispose();
      }
    });
    terminal.show();
  },
});
