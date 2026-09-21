import * as vscode from 'vscode';
import { COMMAND_FORGET_PASSWORD } from '../constants';
import { showInformationMessage } from '../host';
import { CredentialResolver, getSecretStore } from '../core/credentialResolver';
import { getAllFileService } from '../modules/serviceManager';
import { checkCommand } from './abstract/createCommand';

interface StoredCredential extends vscode.QuickPickItem {
  keys: string[];
}

/**
 * A remembered password is only usable if it can also be forgotten - when it
 * changes on the server, or when it shouldn't have been kept at all.
 */
export default checkCommand({
  id: COMMAND_FORGET_PASSWORD,

  async handleCommand() {
    const seen = new Set<string>();
    const items: StoredCredential[] = [];

    getAllFileService().forEach(service => {
      const configs = service.getAvailableProfiles().length
        ? service.getAllConfig()
        : [service.getConfig()];

      configs.forEach(config => {
        const resolver = new CredentialResolver(
          {
            protocol: config.protocol,
            host: config.host,
            port: config.port,
            username: config.username,
            privateKeyPath: config.privateKeyPath,
          },
          // Only the key derivation is wanted here; nothing is read or run.
          {
            store: getSecretStore(),
            prompt: async () => undefined,
            runCommand: async () => '',
            runWriteCommand: async () => undefined,
            runProgram: async () => '',
            storeFor: () => undefined,
            defaultManager: () => true,
          }
        );

        const label = `${config.username || ''}@${config.host}:${config.port}`;
        if (seen.has(label)) {
          return;
        }
        seen.add(label);

        items.push({
          label,
          description: config.name ? `(${config.name})` : undefined,
          keys: [resolver.passwordKey, resolver.passphraseKey],
        });
      });
    });

    if (items.length <= 0) {
      showInformationMessage('No configured servers.');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Forget the stored password and passphrase for',
      canPickMany: true,
    });
    if (picked === undefined || picked.length <= 0) {
      return;
    }

    const store = getSecretStore();
    // Deleting a key that isn't there is not an error, so there's no need to
    // look first, and no need to say which ones existed.
    await Promise.all(
      picked.reduce<Promise<void>[]>(
        (acc, item) => acc.concat(item.keys.map(key => store.delete(key))),
        []
      )
    );

    showInformationMessage(
      picked.length === 1
        ? `Forgot the stored credentials for ${picked[0].label}.`
        : `Forgot the stored credentials for ${picked.length} servers.`
    );
  },
});
