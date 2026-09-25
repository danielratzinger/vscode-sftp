import { Readable } from 'stream';
import {
  PROBE_COMMAND,
  forgetServerTar,
  folderSizeCommand,
  packFolderCommand,
  packListCommand,
  readFolderSize,
  quote,
  readFlavour,
  serverTar,
} from '../serverTar';

function readableOf(text: string): Readable {
  const stream = new Readable();
  stream.push(text);
  stream.push(null);
  return stream;
}

/** A server that answers the probe however the test wants it answered. */
function createHost(
  answer: { says?: string; code?: number; refuses?: boolean } = {}
) {
  const commands: string[] = [];

  return {
    commands,
    exec(command: string) {
      commands.push(command);
      if (answer.refuses) {
        return Promise.reject(new Error('Unable to exec'));
      }

      return Promise.resolve({
        stdin: null as any,
        stdout: readableOf(answer.says === undefined ? 'tar (GNU tar) 1.34' : answer.says),
        stderr: () => '',
        done: Promise.resolve(answer.code === undefined ? 0 : answer.code),
        cancel: () => undefined,
      });
    },
  };
}

describe('telling one tar from another', () => {
  it('knows GNU', () => {
    expect(readFlavour('tar (GNU tar) 1.34\nCopyright ...')).toBe('gnu');
  });

  it('knows bsdtar, by either name it goes under', () => {
    expect(readFlavour('bsdtar 3.5.3 - libarchive 3.5.3')).toBe('bsd');
    expect(readFlavour('libarchive 3.6.2')).toBe('bsd');
  });

  it('says nothing about a tar it does not recognise', () => {
    expect(readFlavour('tar: unknown option -- version')).toBeNull();
    expect(readFlavour('')).toBeNull();
  });
});

describe('putting a path into a command', () => {
  it('leaves a shell nothing to interpret', () => {
    expect(quote('/var/www/site')).toBe(`'/var/www/site'`);
    expect(quote('/srv/a b/c;rm -rf /')).toBe(`'/srv/a b/c;rm -rf /'`);
    expect(quote("/srv/it's")).toBe(`'/srv/it'\\''s'`);
  });

  it('quotes the folder in both commands', () => {
    expect(packFolderCommand('gnu', '/var/www; echo')).toContain(
      `-C '/var/www; echo'`
    );
    expect(packListCommand('gnu', '/var/www; echo')).toContain(
      `-C '/var/www; echo'`
    );
  });
});

describe('the command that packs', () => {
  it('asks for a format that carries the timestamps', () => {
    expect(packFolderCommand('gnu', '/srv')).toContain('--format=pax');
  });

  it('does not follow symlinks, so they stay links', () => {
    // Neither -h nor --dereference: a transfer recreates a link as a link.
    expect(packFolderCommand('gnu', '/srv')).not.toMatch(/(^|\s)-h(\s|$)/);
    expect(packFolderCommand('gnu', '/srv')).not.toContain('--dereference');
  });

  it('tells GNU that an unreadable file is a complaint, not a failure', () => {
    expect(packFolderCommand('gnu', '/srv')).toContain('--ignore-failed-read');
    // The other one has no such flag; a failure there falls back instead.
    expect(packFolderCommand('bsd', '/srv')).not.toContain('--ignore-failed-read');
  });

  it('reads a list of names separated by nothing a name may contain', () => {
    expect(packListCommand('gnu', '/srv')).toContain('--null -T -');
  });
});

describe('asking how much a folder comes to', () => {
  it('leaves the shell nothing to read in the folder name', () => {
    expect(folderSizeCommand("/srv/it's; rm -rf /")).toContain(
      `'/srv/it'\\''s; rm -rf /'`
    );
  });

  it('reads the kilobytes du printed, as bytes', () => {
    expect(readFolderSize('482516\n')).toBe(482516 * 1024);
    expect(readFolderSize('482516\t/srv/site\n')).toBe(482516 * 1024);
  });

  it('says nothing when du said nothing it can use', () => {
    expect(readFolderSize('')).toBeUndefined();
    expect(readFolderSize('du: cannot read directory')).toBeUndefined();
  });
});

describe('asking a server what it has', () => {
  it('reports the flavour it found', async () => {
    const host = createHost({ says: 'tar (GNU tar) 1.34' });

    await expect(serverTar(host)).resolves.toEqual({ flavour: 'gnu' });
    expect(host.commands).toEqual([PROBE_COMMAND]);
    forgetServerTar(host);
  });

  it('asks only once per connection', async () => {
    const host = createHost();

    await serverTar(host);
    await serverTar(host);

    expect(host.commands).toHaveLength(1);
    forgetServerTar(host);
  });

  it('gives up on a server that will not run anything', async () => {
    const host = createHost({ refuses: true });

    await expect(serverTar(host)).resolves.toBeNull();
    forgetServerTar(host);
  });

  it('gives up when tar or gzip is missing', async () => {
    const host = createHost({ says: '', code: 127 });

    await expect(serverTar(host)).resolves.toBeNull();
    forgetServerTar(host);
  });

  it('gives up on a tar it cannot place', async () => {
    const host = createHost({ says: 'tar: illegal option -- -' });

    await expect(serverTar(host)).resolves.toBeNull();
    forgetServerTar(host);
  });
});
