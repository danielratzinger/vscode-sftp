jest.mock('fs');

import { vol } from 'memfs';
import * as fse from 'fs-extra';
import { DEFAULT_PORT, isAddressInUse, isAlive, whoHasThePort } from '../leader';
import { discoveryPath } from '../discovery';

const SANDBOX = '/sandbox';

beforeEach(() => {
  process.env.VSCODE_SFTP_HOME = SANDBOX;
  vol.reset();
  vol.fromJSON({ [`${SANDBOX}/.keep`]: '' });
});

afterAll(() => {
  delete process.env.VSCODE_SFTP_HOME;
});

async function writePeer(peer: object) {
  await fse.writeFile(discoveryPath(), JSON.stringify(peer));
}

describe('isAddressInUse', () => {
  it('recognises the one error that means somebody got there first', () => {
    expect(isAddressInUse({ code: 'EADDRINUSE' })).toBe(true);
    expect(isAddressInUse({ code: 'EACCES' })).toBe(false);
    expect(isAddressInUse(undefined)).toBe(false);
  });
});

describe('isAlive', () => {
  it('knows this process is running', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('knows a pid that is gone', () => {
    // Never a real pid; the kernel would have to wrap all the way round.
    expect(isAlive(0x7ffffff0)).toBe(false);
  });
});

describe('whoHasThePort', () => {
  it('recognises another window of this extension', async () => {
    await writePeer({ port: DEFAULT_PORT, pid: process.pid, workspace: '/work/other' });

    const verdict = await whoHasThePort(DEFAULT_PORT);

    expect(verdict.heldByPeer).toBe(true);
    expect(verdict.peer!.workspace).toBe('/work/other');
  });

  it('treats a dead peer as a stranger, so the port is retaken', async () => {
    // VS Code crashed and left its details behind.
    await writePeer({ port: DEFAULT_PORT, pid: 0x7ffffff0 });

    const verdict = await whoHasThePort(DEFAULT_PORT);
    expect(verdict.heldByPeer).toBe(false);
    expect(verdict.heldByStranger).toBe(true);
  });

  it('treats a peer on a different port as a stranger', async () => {
    await writePeer({ port: 9999, pid: process.pid });

    expect((await whoHasThePort(DEFAULT_PORT)).heldByPeer).toBe(false);
  });

  it('calls it a stranger when there are no details at all', async () => {
    const verdict = await whoHasThePort(DEFAULT_PORT);

    expect(verdict.heldByPeer).toBe(false);
    expect(verdict.heldByStranger).toBe(true);
  });
});
