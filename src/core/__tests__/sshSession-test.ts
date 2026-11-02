import { execFileSync } from 'child_process';
import { AskpassAnswers, AskpassDeps, promptKind, shellQuote, sshCommandLine } from '../sshSession';

/** What `sh` makes of a line: the arguments it would pass, one per line. */
function argvOf(line: string): string[] {
  const out = execFileSync('/bin/sh', ['-c', `set -- ${line}; for a; do printf '%s\\0' "$a"; done`]);
  return out.toString().split('\0').slice(0, -1);
}

describe('the ssh command line', () => {
  it('reaches ssh as the arguments meant, whatever is in them', () => {
    const line = sshCommandLine(
      { host: 'stage.example.com', port: 2222, username: `o'brien`, privateKeyPath: '/keys/my key' },
      `/var/www/it's here`
    );

    expect(argvOf(line)).toEqual([
      'ssh',
      '-t',
      '-p',
      '2222',
      '-i',
      '/keys/my key',
      `o'brien@stage.example.com`,
      `cd '/var/www/it'\\''s here'; exec $SHELL -l`,
    ]);
  });

  it('leaves the user out when none is configured', () => {
    expect(argvOf(sshCommandLine({ host: 'h' }))).toEqual(['ssh', '-t', 'h']);
  });

  it('lets custom parameters decide what runs, with the folder for ${remotePath}', () => {
    const line = sshCommandLine(
      { host: 'h', username: 'u', sshCustomParams: '"cd ${remotePath} && bash"' },
      '/srv/app'
    );

    expect(argvOf(line)).toEqual(['ssh', '-t', 'u@h', 'cd /srv/app && bash']);
  });

  it('quotes nothing that needs no quoting', () => {
    expect(shellQuote('/srv/app-1.2')).toBe('/srv/app-1.2');
    expect(shellQuote('$HOME')).toBe(`'$HOME'`);
  });
});

describe('what ssh is asking', () => {
  it('tells the questions apart', () => {
    expect(promptKind(`deploy@stage.example.com's password: `)).toBe('password');
    expect(promptKind('(deploy@stage) Password: ')).toBe('password');
    expect(promptKind(`Enter passphrase for key '/Users/me/.ssh/id_ed25519': `)).toBe('passphrase');
    expect(
      promptKind('Are you sure you want to continue connecting (yes/no/[fingerprint])? ')
    ).toBe('confirm');
    expect(promptKind('Verification code: ')).toBe('other');
  });
});

function deps(stored: { password?: string; passphrase?: string } = {}) {
  const asked: string[] = [];
  const reads = { password: 0, passphrase: 0 };
  const made: AskpassDeps = {
    password: async () => {
      reads.password += 1;
      return stored.password;
    },
    passphrase: async () => {
      reads.passphrase += 1;
      return stored.passphrase;
    },
    ask: async prompt => {
      asked.push(prompt);
      return 'typed';
    },
    confirm: async () => true,
  };
  return { made, asked, reads };
}

describe('answering ssh', () => {
  const PASSWORD = `deploy@stage's password: `;

  it('gives the stored password once, then asks, saying why', async () => {
    const d = deps({ password: 'S3cret' });
    const answers = new AskpassAnswers(d.made);

    expect(await answers.answer(PASSWORD)).toBe('S3cret');
    expect(await answers.answer(PASSWORD)).toBe('typed');
    expect(await answers.answer(PASSWORD)).toBe('typed');

    expect(d.asked).toEqual([`The stored password was not accepted. ${PASSWORD}`, PASSWORD]);
  });

  it('asks plainly when nothing is stored', async () => {
    const d = deps();
    const answers = new AskpassAnswers(d.made);

    expect(await answers.answer(PASSWORD)).toBe('typed');
    expect(await answers.answer(PASSWORD)).toBe('typed');
    expect(d.asked).toEqual([PASSWORD, PASSWORD]);
    expect(d.reads.password).toBe(1);
  });

  it('never reads the password for a key passphrase, nor the other way round', async () => {
    const d = deps({ password: 'pw', passphrase: 'pp' });
    const answers = new AskpassAnswers(d.made);

    expect(await answers.answer(`Enter passphrase for key '/k': `)).toBe('pp');
    expect(d.reads.password).toBe(0);
  });

  it('asks rather than failing when the store cannot be read', async () => {
    const d = deps();
    d.made.password = () => Promise.reject(new Error('locked'));
    const answers = new AskpassAnswers(d.made);

    expect(await answers.answer(PASSWORD)).toBe('typed');
  });

  it('answers a host key question with yes only when the user says so', async () => {
    const d = deps();
    const question = 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ';

    expect(await new AskpassAnswers(d.made).answer(question)).toBe('yes');
    d.made.confirm = async () => false;
    expect(await new AskpassAnswers(d.made).answer(question)).toBeUndefined();
  });
});
