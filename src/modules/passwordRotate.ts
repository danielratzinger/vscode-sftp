import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import logger from '../logger';
import { accountOf, withPasswordChanged } from '../core/credentialSweep';
import { detectIndent } from '../core/credentialMigration';
import {
  everythingMovable,
  managerOf,
  Movable,
  storeFor,
  whichFiles,
} from './passwordSweep';
import { noteCredentialKey } from './credentials';

/**
 * Changing one server's password everywhere it is written down.
 *
 * The cost of keeping a record per project: six sites on one hosting account
 * hold six copies of the same password, and a rotation that updates one of
 * them leaves five connections that will start failing at a time nobody is
 * watching. A record per project is still the right shape - it is how these
 * are thought about, and it lets two connections on one account differ - but
 * it only works if changing the account's password is a single act.
 *
 * Wherever each copy lives: a literal in a config file is rewritten, a stored
 * one is written to its store. Nothing is deleted and nothing moves; only the
 * value changes.
 */

interface Account {
  account: string;
  entries: Movable[];
}

function accountsIn(all: Movable[]): Account[] {
  const grouped = new Map<string, Movable[]>();

  all
    .filter(one => one.kind === 'password')
    .forEach(one => {
      const account = accountOf(one.key);
      grouped.set(account, (grouped.get(account) || []).concat(one));
    });

  return Array.from(grouped.entries())
    .map(([account, entries]) => ({ account, entries }))
    .sort((a, b) => (a.account < b.account ? -1 : 1));
}

/** `dr@univers.metanet.ch:2121`, which is what a person recognises. */
function readable(account: string): string {
  return account.replace(/^[a-z]+:\/\//i, '');
}

export async function rotateOneAccount(): Promise<void> {
  const looking = await whichFiles();
  if (!looking) {
    return;
  }

  const { movable: all } = await everythingMovable(looking.paths);
  const accounts = accountsIn(all);

  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      `No password to change in ${looking.scope}.`
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    accounts.map(one => ({
      label: readable(one.account),
      description: `${one.entries.length} connection${
        one.entries.length === 1 ? '' : 's'
      }`,
      detail: one.entries.map(each => each.label).join(', '),
      account: one,
    })),
    { title: 'Which server’s password has changed?' }
  );

  if (!picked) {
    return;
  }

  const entries = picked.account.entries;

  const value = await vscode.window.showInputBox({
    title: `New password for ${readable(picked.account.account)}`,
    prompt: `It will be written to all ${entries.length} connection${
      entries.length === 1 ? '' : 's'
    } on this server: ${entries.map(one => one.label).join(', ')}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: given =>
      given === '' ? 'An empty password would lock you out of all of them.' : undefined,
  });

  if (!value) {
    return;
  }

  await write(entries, value);
}

async function write(entries: Movable[], value: string): Promise<void> {
  let changed = 0;
  let refused = 0;

  // Per file, so one holding six of them is rewritten once.
  const inFiles = new Map<string, string[]>();

  for (const one of entries) {
    if (one.literal !== undefined) {
      inFiles.set(one.file, (inFiles.get(one.file) || []).concat(one.key));
      continue;
    }

    const store = storeFor(managerOf(undefined));
    if (!store) {
      refused += 1;
      continue;
    }

    try {
      await store.set(one.key, value);
      if ((await store.get(one.key)) !== value) {
        throw new Error('what came back was not what went in');
      }
      // Noted, and thereby moved to the front of the list: this is now the
      // most recent word on that login, which is what a store with no dates of
      // its own goes by.
      await noteCredentialKey(one.key);
      changed += 1;
    } catch (error) {
      refused += 1;
      logger.warn(`[passwords] could not change ${one.label}: ${error.message}`);
    }
  }

  for (const [file, keys] of Array.from(inFiles.entries())) {
    try {
      const text = await fse.readFile(file, 'utf8');
      const config = withPasswordChanged(JSON.parse(text), keys, value);
      await fse.writeFile(
        file,
        `${JSON.stringify(config, null, detectIndent(text))}\n`
      );
      changed += keys.length;
    } catch (error) {
      refused += keys.length;
      logger.error(error, `could not change the passwords in ${file}`);
    }
  }

  vscode.window.showInformationMessage(
    `${changed} connection${changed === 1 ? '' : 's'} updated` +
      (refused > 0 ? `; ${refused} could not be.` : '.') +
      ' Nothing was tried against the server - if it is wrong, the first ' +
      'connection will say so and ask.'
  );
}
