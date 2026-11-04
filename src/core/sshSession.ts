/**
 * An interactive SSH session to a connection's server, in a terminal.
 *
 * The command is run by the terminal itself rather than typed into a shell, so
 * it never reaches a shell history; and the password is never part of it.
 * `ssh` asks for every secret through an askpass program instead, which hands
 * the question to the editor - where the stored password answers it, once.
 */

export interface SshTarget {
  host: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  /** Appended as written, as it always was: options, a command, or both. */
  sshCustomParams?: string;
}

/** One argument, quoted for a POSIX shell. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-+=.,:@%/]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `ssh` command line, for `sh -c`.
 *
 * Without custom parameters the session starts in `remoteDir`. That command is
 * run by the login shell on the server, which may be any shell at all, so it
 * asks for nothing beyond `cd`, `;` and `$SHELL`. With custom parameters they
 * decide what runs, as they always did, and `${remotePath}` in them is the
 * folder the session was opened on.
 */
export function sshCommandLine(
  target: SshTarget,
  remoteDir?: string,
  extraArgs: string[] = []
): string {
  // A session left alone sends nothing, and a router or firewall on the way
  // forgets a connection that has been quiet for some minutes - the next key
  // pressed then finds it gone. A small message every 30 seconds keeps it
  // known, and a server that stops answering them is given up on after two
  // minutes instead of leaving the terminal hanging.
  const args = ['ssh', '-t', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4'];
  if (target.port) {
    args.push('-p', String(target.port));
  }
  if (target.privateKeyPath) {
    args.push('-i', target.privateKeyPath.replace(/\\/g, '/'));
  }
  args.push(...extraArgs);
  args.push(target.username ? `${target.username}@${target.host}` : target.host);

  let line = args.map(shellQuote).join(' ');

  if (target.sshCustomParams) {
    line += ' ' + target.sshCustomParams.replace(/\$\{remotePath\}/g, remoteDir || '');
  } else if (remoteDir) {
    line += ' ' + shellQuote(`cd ${shellQuote(remoteDir)}; exec $SHELL -l`);
  }

  return line;
}

export type PromptKind = 'confirm' | 'passphrase' | 'password' | 'other';

/** What `ssh` is asking, from the text of the question. */
export function promptKind(prompt: string): PromptKind {
  if (/\(yes\/no/i.test(prompt)) {
    return 'confirm';
  }
  if (/passphrase/i.test(prompt)) {
    return 'passphrase';
  }
  if (/password/i.test(prompt)) {
    return 'password';
  }
  return 'other';
}

export interface AskpassDeps {
  /** The stored password, read when `ssh` first asks for one. */
  password(): Promise<string | undefined>;
  passphrase(): Promise<string | undefined>;
  /** Asks the user; undefined is a cancel. */
  ask(prompt: string, secret: boolean): Promise<string | undefined>;
  confirm(prompt: string): Promise<boolean>;
}

/**
 * Answers the questions of one `ssh`.
 *
 * A stored secret answers the first time it is asked for, and only then: a
 * second question means the server refused it, and sending it again would
 * only count against the account. From then on the user is asked.
 */
export class AskpassAnswers {
  /** Per kind: not yet asked, answered from the store, or left to the user. */
  private state: { [kind: string]: 'stored' | 'asked' } = {};

  constructor(private readonly deps: AskpassDeps) {}

  async answer(prompt: string): Promise<string | undefined> {
    const kind = promptKind(prompt);

    if (kind === 'confirm') {
      return (await this.deps.confirm(prompt)) ? 'yes' : undefined;
    }

    if (kind === 'password' || kind === 'passphrase') {
      const before = this.state[kind];
      if (!before) {
        const stored = await (kind === 'password'
          ? this.deps.password()
          : this.deps.passphrase()
        ).catch(() => undefined);
        if (stored !== undefined && stored !== '') {
          this.state[kind] = 'stored';
          return stored;
        }
      }
      this.state[kind] = 'asked';
      return this.deps.ask(
        before === 'stored' ? `The stored ${kind} was not accepted. ${prompt}` : prompt,
        true
      );
    }

    // A one-time code, or anything else the server thinks to ask.
    return this.deps.ask(prompt, true);
  }
}
