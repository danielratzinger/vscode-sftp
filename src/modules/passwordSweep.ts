import * as path from 'path';
import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import logger from '../logger';
import { getUserSetting } from '../host';
import { COMMAND_TOGGLE_OUTPUT, CONFIG_PATH } from '../constants';
import { getAllFileService } from './serviceManager';
import {
  secretsIn,
  storedIn,
  withManagersRemoved,
  withSecretsRemoved,
  withSecretsWritten,
  FoundSecret,
} from '../core/credentialSweep';
import { detectIndent } from '../core/credentialMigration';
import { SecretStore } from '../core/credentialResolver';
import { secretStoreFor } from './credentials';

/**
 * Deciding where every password lives, and moving them all there.
 *
 * Not a migration in one direction. A password can be in a config file, in the
 * Keychain, in VS Code's storage, or in something only readable like
 * 1Password, and the question worth answering is "put them all *here*"
 * whichever of those they are in now - including back into the files, which is
 * the direction nobody builds and everybody eventually wants, usually at the
 * moment they are trying to leave.
 *
 * The order never changes, whichever way it is going. Every secret is written
 * to its new home and read back before anything is taken out of its old one.
 * A store that refuses, a keychain that is locked, a value that comes back
 * different: that secret stays where it was. Losing the only copy of a
 * password is a worse outcome than leaving it somewhere you would rather it
 * was not.
 */

interface Where {
  label: string;
  /** What `sftp.passwordManager` becomes. `false` means the files. */
  manager: string | false;
  description: string;
}

export interface Movable {
  file: string;
  kind: 'password' | 'passphrase';
  key: string;
  label: string;
  /** Where it is now, for saying so and for taking it out afterwards. */
  from: string;
  /** Read when the move happens, not before: this is a secret. */
  read(): Promise<string | undefined>;
  /** The literal to clear, when it is in the file. */
  literal?: string;
}

function destinations(): Where[] {
  const all: Where[] = [];

  if (process.platform === 'darwin') {
    all.push({
      label: 'macOS Keychain',
      manager: 'keychain',
      description: 'your login keychain; not synced to iCloud',
    });
  }

  all.push({
    label: 'VS Code secret storage',
    manager: 'vscode',
    description: 'the editor’s own store, on any platform',
  });

  all.push({
    label: 'The config files',
    manager: false,
    description: 'written back into sftp.json as plain text',
  });

  return all;
}

/** The manager a connection resolves against today. */
export function managerOf(named: string | boolean | undefined): string | boolean {
  if (named !== undefined) {
    return named;
  }

  return getUserSetting('sftp').get<string | boolean>('passwordManager', true);
}

/** A writable store by the name a config or setting uses. */
export function storeFor(manager: string | boolean): SecretStore | undefined {
  if (manager === false) {
    return undefined;
  }

  return secretStoreFor(manager === true ? 'true' : manager);
}

function nameOf(manager: string | boolean): string {
  if (manager === false) {
    // The same words `everythingMovable` uses for a literal, so a password
    // already written in a file counts as being at that destination. Anything
    // else and moving "to the config files" would write each literal back over
    // itself and then clear it by value on the same pass.
    return 'the file';
  }
  if (manager === true) {
    return process.platform === 'darwin' ? 'keychain' : 'vscode';
  }

  return manager;
}

/** The configs behind the connections this window has open. */
function filesInThisWindow(): string[] {
  const paths = new Set<string>();
  getAllFileService().forEach(service =>
    paths.add(path.join(service.workspace, CONFIG_PATH))
  );

  return Array.from(paths);
}

/** How far below a chosen folder a project's config can be and still be found. */
const DEPTH = 3;

const SKIP = ['node_modules', 'vendor', 'dist', 'build', '.git', 'Library'];

/**
 * Every `sftp.json` under a folder.
 *
 * Because "all my projects" is what anybody means by this, and a window only
 * ever has one or two of them open. Bounded: three levels, skipping what is
 * never a project.
 */
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > DEPTH) {
      return;
    }

    const here = path.join(dir, CONFIG_PATH);
    if (await fse.pathExists(here)) {
      found.push(here);
    }

    let entries: string[];
    try {
      entries = await fse.readdir(dir);
    } catch (error) {
      return;
    }

    for (const name of entries) {
      if (name.charAt(0) === '.' || SKIP.indexOf(name) !== -1) {
        continue;
      }

      const full = path.join(dir, name);
      try {
        if ((await fse.lstat(full)).isDirectory()) {
          await visit(full, depth + 1);
        }
      } catch (error) {
        // Gone, or not ours to read.
      }
    }
  };

  await visit(path.resolve(root), 0);

  return found;
}

/**
 * Which configs to work on.
 *
 * The connections in the Remote Explorer, which is what "all of them" means
 * while you are looking at it - and is the whole of a workspace like one
 * holding twenty-eight sites in a single file. Or every `sftp.json` under a
 * folder, for the other arrangement, where each project is its own window and
 * the passwords are spread across all of them.
 *
 * With nothing open there is no first option to offer, so it goes straight to
 * asking where to look.
 */
export async function whichFiles(): Promise<{ paths: string[]; scope: string } | undefined> {
  const here = filesInThisWindow();
  const connections = getAllFileService().length;

  if (connections > 0) {
    const chosen = await vscode.window.showQuickPick(
      [
        {
          label: 'Every connection in the SFTP Explorer',
          description: `${connections} connection${
            connections === 1 ? '' : 's'
          }, ${here.length} config file${here.length === 1 ? '' : 's'}`,
          everywhere: false,
        },
        {
          label: 'A folder I choose\u2026',
          description: 'every sftp.json under it, three levels deep',
          everywhere: true,
        },
      ],
      { placeHolder: 'Which connections should this look at?' }
    );

    if (!chosen) {
      return undefined;
    }

    if (!chosen.everywhere) {
      return {
        paths: here,
        scope: `the ${connections} connection${
          connections === 1 ? '' : 's'
        } in this window`,
      };
    }
  }

  const folders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Look for sftp.json here',
  });

  if (!folders || folders.length === 0) {
    return undefined;
  }

  const paths = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'SFTP: looking for config files\u2026',
    },
    () => filesUnder(folders[0].fsPath)
  );

  return {
    paths,
    scope: `${paths.length} config file${
      paths.length === 1 ? '' : 's'
    } under ${path.basename(folders[0].fsPath)}`,
  };
}

export interface Clash {
  file: string;
  /** The connection whose secret cannot be moved. */
  label: string;
  /** The one already using that store entry, with a different secret. */
  against: string;
  key: string;
}

/** Everything that could be moved, and where it is now. */
export async function everythingMovable(
  paths: string[]
): Promise<{ movable: Movable[]; clashes: Clash[] }> {
  const found: Movable[] = [];
  const clashes: Clash[] = [];

  for (const file of paths) {
    let parsed: any;
    try {
      parsed = JSON.parse(await fse.readFile(file, 'utf8'));
    } catch (error) {
      continue;
    }

    const literals = secretsIn(parsed);
    const owner = new Map<string, string>();
    literals
      .filter(one => !one.conflict)
      .forEach(one => owner.set(one.key, one.label));

    literals.forEach((one: FoundSecret) => {
      if (one.conflict) {
        clashes.push({
          file,
          label: one.label,
          against: owner.get(one.key) || 'another connection',
          key: one.key,
        });
        return;
      }

      found.push({
        file,
        kind: one.kind,
        key: one.key,
        label: one.label,
        from: 'the file',
        literal: one.value,
        read: async () => one.value,
      });
    });

    storedIn(parsed).forEach(one => {
      const manager = managerOf(one.manager);
      const store = storeFor(manager);

      found.push({
        file,
        kind: one.kind,
        key: one.key,
        label: one.label,
        from: nameOf(manager),
        read: async () => (store ? store.get(one.key) : undefined),
      });
    });
  }

  return { movable: found, clashes };
}

/**
 * Writes down which connections cannot be moved, and why, by name.
 *
 * Only writes. Asking about them in the middle of the run was a mistake worth
 * recording: the question arrived before the destination picker, and
 * answering it - "Show which", which opens the output panel - moved the focus
 * and dismissed the picker behind it. The command then returned having done
 * nothing at all, with nothing on screen to say why. A report is not worth
 * interrupting a run for; it is worth showing when the run is over.
 */
function noteClashes(clashes: Clash[]): void {
  clashes.forEach(one =>
    logger.warn(
      `[passwords] ${one.label} holds a different password from ${one.against}, ` +
        `and both are ${one.key.replace(/^password:/, '')}. Neither was moved. ` +
        `(${one.file})`
    )
  );
}

/** Said afterwards, when there is nothing left to interrupt. */
async function showClashes(clashes: Clash[]): Promise<void> {
  if (clashes.length === 0) {
    return;
  }

  const show = 'Show which';
  const answer = await vscode.window.showWarningMessage(
    `${clashes.length} connection${clashes.length === 1 ? '' : 's'} could not ` +
      'be moved: each holds a different password for a server another ' +
      'connection already covers, and one entry cannot hold two passwords.',
    show
  );

  if (answer === show) {
    await vscode.commands.executeCommand(COMMAND_TOGGLE_OUTPUT);
  }
}

export async function sweepPasswordsIntoAManager(): Promise<void> {
  const looking = await whichFiles();
  if (!looking) {
    return;
  }

  const { paths, scope } = looking;
  const { movable: all, clashes } = await everythingMovable(paths);
  noteClashes(clashes);

  if (all.length === 0) {
    vscode.window.showInformationMessage(
      `Nothing to move in ${scope}: no password is written in a config file ` +
        'there, and none is marked as stored.'
    );
    await showClashes(clashes);
    return;
  }

  const where = await vscode.window.showQuickPick(
    destinations().map(one => ({
      label: one.label,
      description: one.description,
      where: one,
    })),
    {
      placeHolder:
        `Keep every password where? ${all.length} found in ${scope} \u2014 ` +
        describeWhere(all),
    }
  );

  if (!where) {
    return;
  }

  const destination = where.where;
  const target = nameOf(destination.manager);
  const moving = all.filter(one => one.from !== target);

  if (moving.length === 0) {
    // The message somebody reads when they expected something to happen, so it
    // says what was looked at rather than only what was not done.
    vscode.window.showInformationMessage(
      `Nothing to do: all ${all.length} password${all.length === 1 ? '' : 's'} ` +
        `in ${scope} ${all.length === 1 ? 'is' : 'are'} already in ` +
        `${destination.label}.`
    );
    await showClashes(clashes);
    return;
  }

  // A third quick pick rather than a modal, because the two questions before
  // it were quick picks and a native dialog dropped into the middle of that
  // reads as something having gone wrong. Escape still cancels, which is the
  // safe direction.
  const consequences = [
    `\u00b7 ${describeWhere(moving)}`,
    '\u00b7 each is written and read back before it leaves where it is',
    `\u00b7 sftp.passwordManager becomes ${
      destination.manager === false ? 'false' : `"${destination.manager}"`
    }, and any set on a connection is removed`,
  ];

  if (clashes.length > 0) {
    consequences.push(
      `\u00b7 ${clashes.length} cannot be moved and stay where they are`
    );
  }

  if (destination.manager === false) {
    consequences.push(
      '\u00b7 the passwords will be in plain text in your sftp.json files'
    );
  }

  const answer = await vscode.window.showQuickPick(
    [
      {
        label: `Move ${moving.length}`,
        description: `into ${destination.label}`,
        detail: consequences.join('   '),
        go: true,
      },
      {
        label: 'Cancel',
        description: 'nothing is changed',
        detail: '',
        go: false,
      },
    ],
    {
      title: `Move ${moving.length} secret${
        moving.length === 1 ? '' : 's'
      } into ${destination.label}?`,
      placeHolder: 'This rewrites your config files.',
    }
  );

  if (!answer || !answer.go) {
    return;
  }

  await move(moving, destination);
  await showClashes(clashes);
}

/** `3 in the file, 2 in keychain` - what a person needs before agreeing. */
function describeWhere(all: Movable[]): string {
  const counted = new Map<string, number>();
  all.forEach(one => counted.set(one.from, (counted.get(one.from) || 0) + 1));

  return Array.from(counted.entries())
    .map(([from, count]) => `${count} in ${from}`)
    .join(', ');
}

async function move(moving: Movable[], destination: Where): Promise<void> {
  const into = storeFor(destination.manager);
  if (destination.manager !== false && !into) {
    vscode.window.showErrorMessage(
      `${destination.label} is not available on this machine.`
    );
    return;
  }

  let arrived = 0;
  let left = 0;

  // Per file, so each is rewritten once whatever moved out of or into it.
  const intoFile = new Map<string, { [key: string]: string }>();
  const outOfFile = new Map<string, FoundSecret[]>();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Moving passwords into ${destination.label}`,
      cancellable: true,
    },
    async (progress, token) => {
      for (const one of moving) {
        if (token.isCancellationRequested) {
          break;
        }

        progress.report({ increment: 100 / moving.length, message: one.label });

        let value: string | undefined;
        try {
          value = await one.read();
        } catch (error) {
          value = undefined;
        }

        if (value === undefined) {
          // Marked as stored but nothing is there - it has never been entered,
          // or it was forgotten. Nothing to move and nothing to lose.
          logger.info(`[passwords] ${one.label}: nothing in ${one.from} to move.`);
          continue;
        }

        try {
          if (into) {
            await into.set(one.key, value);
            const back = await into.get(one.key);
            if (back !== value) {
              throw new Error('what came back was not what went in');
            }
          } else {
            const forFile = intoFile.get(one.file) || {};
            forFile[one.key] = value;
            intoFile.set(one.file, forFile);
          }

          arrived += 1;

          if (one.literal !== undefined) {
            const list = outOfFile.get(one.file) || [];
            list.push({
              kind: one.kind,
              key: one.key,
              label: one.label,
              value: one.literal,
            });
            outOfFile.set(one.file, list);
          }
        } catch (error) {
          left += 1;
          logger.warn(`[passwords] left ${one.label} in ${one.from}: ${error.message}`);
        }
      }
    }
  );

  await rewriteFiles(moving, intoFile, outOfFile);
  await forgetOldStores(moving, destination);

  await getUserSetting('sftp').update(
    'passwordManager',
    destination.manager,
    vscode.ConfigurationTarget.Global
  );

  vscode.window.showInformationMessage(
    `${arrived} secret${arrived === 1 ? '' : 's'} moved into ${destination.label}` +
      (left > 0 ? `; ${left} left where they were. The output panel says why.` : '.')
  );
}

async function rewriteFiles(
  moving: Movable[],
  intoFile: Map<string, { [key: string]: string }>,
  outOfFile: Map<string, FoundSecret[]>
): Promise<void> {
  const files = new Set([
    ...Array.from(intoFile.keys()),
    ...Array.from(outOfFile.keys()),
    // Even a file that gave up nothing may name a manager of its own, which
    // would quietly override the setting everything else now follows.
    ...moving.map(one => one.file),
  ]);

  for (const file of Array.from(files)) {
    try {
      const text = await fse.readFile(file, 'utf8');
      let config = JSON.parse(text);

      const written = intoFile.get(file);
      if (written) {
        config = withSecretsWritten(config, written);
      }

      const removed = outOfFile.get(file);
      if (removed) {
        config = withSecretsRemoved(config, removed);
      }

      config = withManagersRemoved(config);

      await fse.writeFile(
        file,
        `${JSON.stringify(config, null, detectIndent(text))}\n`
      );
    } catch (error) {
      logger.error(error, `could not rewrite ${file}`);
    }
  }
}

/**
 * Takes each secret out of where it used to be.
 *
 * Last, and only for what arrived: a delete that runs before the write is
 * confirmed is how a password stops existing.
 */
async function forgetOldStores(
  moving: Movable[],
  destination: Where
): Promise<void> {
  for (const one of moving) {
    if (one.literal !== undefined || one.from === nameOf(destination.manager)) {
      continue; // It was in a file, which the rewrite has already handled.
    }

    const store = storeFor(one.from);
    if (!store) {
      continue;
    }

    try {
      await store.delete(one.key);
    } catch (error) {
      logger.warn(`[passwords] could not clear ${one.label} from ${one.from}.`);
    }
  }
}
