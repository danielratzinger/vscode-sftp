import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import {
  configureCredentials,
  passwordKeyFor,
  SecretStore,
} from '../core/credentialResolver';
import {
  KeyRegistry,
  withKey,
  withoutKey,
} from '../core/credentialKeys';
import { getAllFileService } from './serviceManager';
import { createKeychainStore } from './keychainStore';
import { promptForPassword } from '../host';
import logger from '../logger';

/** Same shape as a connection's own `passwordManager`. */
type ManagerSetting = string | boolean;

const SECRET_PREFIX = 'sftp:';
const COMMAND_TIMEOUT = 30 * 1000;
const MAX_OUTPUT = 64 * 1024;

/**
 * `context.secrets` (VS Code 1.53+) and `workspace.isTrusted` (1.57+) are both
 * newer than the @types/vscode this project pins, which is older than the
 * engine it declares. Describing the two shapes here keeps the calls typed
 * without dragging a typings upgrade into this change.
 */
interface SecretStorageApi {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/**
 * VS Code's secret storage. On macOS it's encrypted with a key held in the
 * login Keychain, on Windows with the Credential Manager, on Linux with
 * libsecret. Either way the secret never reaches sftp.json.
 */
function createSecretStore(context: vscode.ExtensionContext): SecretStore {
  const secrets: SecretStorageApi | undefined = (context as any).secrets;

  if (!secrets) {
    logger.warn(
      'This version of VS Code has no secret storage, so passwords can\'t be remembered.'
    );
    return {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
  }

  return {
    get: key => Promise.resolve(secrets.get(SECRET_PREFIX + key)),
    set: (key, value) => Promise.resolve(secrets.store(SECRET_PREFIX + key, value)),
    delete: key => Promise.resolve(secrets.delete(SECRET_PREFIX + key)),
  };
}

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders ? folders[0].uri.fsPath : undefined;
}

/** Workspace trust, treating a VS Code too old to have it as trusted. */
function isWorkspaceTrusted(): boolean {
  return (vscode.workspace as any).isTrusted !== false;
}

/**
 * Runs a credential command and takes its output as the secret.
 *
 * The command comes out of a file in the workspace, so running it is running
 * workspace code. That's only allowed in a trusted workspace, the same bar
 * VS Code puts on tasks.
 */
/**
 * Runs a command the user wrote, with a secret on its standard input.
 *
 * Standard input rather than the command line: an argument is visible to
 * anything that can run `ps`, for as long as the process lives. The same
 * reason the Keychain store feeds `security` through `-i`.
 *
 * Output is ignored and never logged. A manager that prints the secret back
 * on success - several do - would otherwise put it in the output panel.
 */
function runCredentialWriteCommand(command: string, value: string): Promise<void> {
  if (!isWorkspaceTrusted()) {
    return Promise.reject(
      new Error(
        'Credential commands only run in a trusted workspace. ' +
          'Trust this workspace, or set the password directly.'
      )
    );
  }

  return new Promise<void>((resolve, reject) => {
    logger.info(`Running credential write command: ${command}`);

    const child = exec(
      command,
      {
        timeout: COMMAND_TIMEOUT,
        maxBuffer: MAX_OUTPUT,
        cwd: workspaceRoot(),
      },
      (error, _stdout, stderr) => {
        if (error) {
          // Never the output: on some managers that is the secret itself.
          reject(
            new Error(
              `the write command failed (${(error as any).code || 'no exit code'})` +
                (stderr && stderr.trim() ? `: ${stderr.trim().split('\n')[0]}` : '')
            )
          );
          return;
        }

        resolve();
      }
    );

    if (child.stdin) {
      child.stdin.end(value);
    }
  });
}

function runCredentialCommand(command: string): Promise<string> {
  if (!isWorkspaceTrusted()) {
    return Promise.reject(
      new Error(
        'Credential commands only run in a trusted workspace. ' +
          'Trust this workspace, or set the password directly.'
      )
    );
  }

  return new Promise<string>((resolve, reject) => {
    logger.info(`Running credential command: ${command}`);

    exec(
      command,
      {
        timeout: COMMAND_TIMEOUT,
        maxBuffer: MAX_OUTPUT,
        cwd: workspaceRoot(),
      },
      (error, stdout, stderr) => {
        if (error) {
          // Never the output itself: that's the secret, or close to it.
          reject(
            new Error(
              `The credential command failed (${error.message.trim()})` +
                (stderr ? `: ${stderr.toString().trim()}` : '')
            )
          );
          return;
        }

        // Trailing newline only; a password may legitimately have spaces.
        resolve(stdout.toString().replace(/\r?\n$/, ''));
      }
    );
  });
}

/**
 * What `true` means on this machine: the Keychain where there is one, and VS
 * Code's own storage otherwise.
 *
 * Under Remote-SSH, WSL or Codespaces this code runs on the remote machine,
 * and `process.platform` is that machine's, which is exactly the check we
 * want - there is no Keychain over there to write to.
 */
function chooseStore(context: vscode.ExtensionContext): SecretStore {
  if (process.platform !== 'darwin') {
    return createSecretStore(context);
  }

  logger.info('Keeping credentials in the macOS Keychain.');
  return createKeychainStore();
}

/**
 * Runs a named provider. Unlike `runCredentialCommand` there is no shell, so
 * a vault path containing spaces or quotes needs no escaping and can't be
 * turned into a second command.
 */
function runCredentialProgram(argv: string[]): Promise<string> {
  if (!isWorkspaceTrusted()) {
    return Promise.reject(
      new Error(
        'Credential providers only run in a trusted workspace. ' +
          'Trust this workspace, or set the password directly.'
      )
    );
  }

  const [program, ...args] = argv;

  return new Promise<string>((resolve, reject) => {
    logger.info(`Reading the password from: ${program}`);

    execFile(
      program,
      args,
      {
        timeout: COMMAND_TIMEOUT,
        maxBuffer: MAX_OUTPUT,
        cwd: workspaceRoot(),
      },
      (error: any, stdout, stderr) => {
        if (error) {
          const detail = stderr ? stderr.toString().trim() : '';
          reject(
            new Error(
              error.code === 'ENOENT'
                ? `"${program}" is not installed, or not on the PATH that VS Code was started with.`
                : `${program} failed (${error.message.trim()})${
                    detail ? `: ${detail}` : ''
                  }`
            )
          );
          return;
        }

        resolve(stdout.toString().replace(/\r?\n$/, ''));
      }
    );
  });
}

/**
 * The stores we can write to as well as read. Anything else named as a manager
 * is read-only, and reached by running its CLI.
 */
function storeFor(
  context: vscode.ExtensionContext,
  builtIn: SecretStore,
  manager: string | boolean
): SecretStore | undefined {
  if (manager === true) {
    return builtIn;
  }

  if (manager === 'vscode') {
    return createSecretStore(context);
  }

  if (manager === 'keychain') {
    if (process.platform !== 'darwin') {
      logger.warn(
        'A credential manager of "keychain" was asked for, but there is no ' +
          'macOS Keychain here.'
      );
      return undefined;
    }

    return createKeychainStore();
  }

  return undefined;
}

/**
 * The setting a connection falls back to when it names no manager of its own.
 * It takes the same values, so the two mean the same thing.
 */
function defaultManager(kind: 'password' | 'passphrase'): ManagerSetting {
  return vscode.workspace
    .getConfiguration('sftp')
    .get<ManagerSetting>(`${kind}Manager`, true);
}

/**
 * A writable store by name, for anything outside the resolver that needs one.
 *
 * Held from `initCredentials` because building a VS Code secret store needs
 * the extension context, and the one thing that asks for this - moving every
 * password out of every config at once - runs long after activation.
 */
let storeByName: ((manager: string) => SecretStore | undefined) | undefined;

export function secretStoreFor(manager: string): SecretStore | undefined {
  return storeByName ? storeByName(manager) : undefined;
}

const WRITTEN_KEYS = 'sftp.credentialKeys';

let registry: KeyRegistry | undefined;

/**
 * Say that a secret was just written under this key.
 *
 * For the resolver this is bookkeeping; for VS Code's secret storage it is the
 * only record there is. That storage cannot be listed, so a password moved into
 * it by `Move All Passwords…` would be invisible - and a connection that was
 * renamed would find nothing and ask, with the password sitting right there.
 * So every write says so, wherever it happens.
 *
 * The order matters as much as the membership: the list is newest first, which
 * is how the choice between several records for one login is made in a store
 * that has no dates to offer.
 */
export function noteCredentialKey(key: string): Promise<void> {
  return registry
    ? registry.write(withKey(registry.read(), key)).catch(() => undefined)
    : Promise.resolve();
}

/** And that one is gone, so nothing is offered a key with nothing behind it. */
export function forgetCredentialKey(key: string): Promise<void> {
  return registry
    ? registry.write(withoutKey(registry.read(), key)).catch(() => undefined)
    : Promise.resolve();
}

/**
 * Whether some configured connection still looks under this key.
 *
 * What tells a renamed connection's abandoned record apart from one that
 * simply belongs to another connection.
 */
function stillInUse(key: string): boolean {
  return getAllFileService().some(service => {
    const config = service.getConfig() as any;

    return (
      passwordKeyFor({
        protocol: config.protocol,
        host: config.host,
        port: config.port,
        username: config.username,
        name: config.name,
      } as any) === key
    );
  });
}

export default function initCredentials(context: vscode.ExtensionContext) {
  const builtIn = chooseStore(context);

  registry = {
    read: () => context.globalState.get<string[]>(WRITTEN_KEYS, []) || [],
    write: keys => Promise.resolve(context.globalState.update(WRITTEN_KEYS, keys)),
    inUse: stillInUse,
  };

  storeByName = manager => storeFor(context, builtIn, manager);

  configureCredentials({
    store: builtIn,
    prompt: promptForPassword,
    runCommand: runCredentialCommand,
    runWriteCommand: runCredentialWriteCommand,
    keys: registry,
    runProgram: runCredentialProgram,
    storeFor: manager => storeFor(context, builtIn, manager),
    defaultManager,
  });
}
