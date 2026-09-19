jest.mock('fs');

import { vol } from 'memfs';
import * as path from 'path';
import { compareLocalWithRemote, describeAge, LocalCopy } from '../compareLocal';
import RemoteFs from '../../../test/helper/localRemoteFs';

const remoteFs = new RemoteFs(path, { client: {} as any });

const LOCAL = '/local/app.js';
const REMOTE = '/remote/app.js';

function createCtx() {
  return {
    target: { localFsPath: LOCAL, remoteFsPath: REMOTE },
    config: {} as any,
    fileService: {
      getRemoteFileSystem: () => Promise.resolve(remoteFs),
    },
  } as any;
}

/** memfs keeps mtimes, so the files are written and then stamped. */
function place(files: { [key: string]: [string, number] }) {
  vol.reset();
  const contents: { [key: string]: string } = {};
  Object.keys(files).forEach(p => {
    contents[p] = files[p][0];
  });
  vol.fromJSON(contents);

  Object.keys(files).forEach(p => {
    const when = new Date(files[p][1]);
    vol.utimesSync(p, when, when);
  });
}

describe('compareLocalWithRemote', () => {
  it('reports nothing on disk', async () => {
    place({ [REMOTE]: ['code', 2000000] });

    expect((await compareLocalWithRemote(createCtx())).state).toBe(
      LocalCopy.Missing
    );
  });

  it('reports the two copies as the same', async () => {
    place({ [LOCAL]: ['code', 2000000], [REMOTE]: ['code', 2000000] });

    expect((await compareLocalWithRemote(createCtx())).state).toBe(LocalCopy.Same);
  });

  it('reports the local copy as older when the server moved on', async () => {
    place({ [LOCAL]: ['code', 1000000], [REMOTE]: ['newer', 2000000] });

    expect((await compareLocalWithRemote(createCtx())).state).toBe(
      LocalCopy.Older
    );
  });

  it('reports the local copy as newer when it has work of its own', async () => {
    place({ [LOCAL]: ['edited', 3000000], [REMOTE]: ['code', 2000000] });

    const comparison = await compareLocalWithRemote(createCtx());
    expect(comparison.state).toBe(LocalCopy.Newer);
    expect(comparison.localMtime).toBe(3000000);
    expect(comparison.remoteMtime).toBe(2000000);
  });

  it('ignores a sub-second difference, as the sync algorithm does', async () => {
    place({ [LOCAL]: ['code', 2000400], [REMOTE]: ['code', 2000000] });

    expect((await compareLocalWithRemote(createCtx())).state).toBe(LocalCopy.Same);
  });

  it('treats the same second with a different size as a local change', async () => {
    place({ [LOCAL]: ['code and more', 2000400], [REMOTE]: ['code', 2000000] });

    expect((await compareLocalWithRemote(createCtx())).state).toBe(
      LocalCopy.Newer
    );
  });

  it('says nothing is there when the remote file is gone', async () => {
    place({ [LOCAL]: ['code', 2000000] });

    expect((await compareLocalWithRemote(createCtx())).state).toBe(
      LocalCopy.Missing
    );
  });
});

describe('describeAge', () => {
  it('gives both timestamps', () => {
    const text = describeAge({
      state: LocalCopy.Newer,
      localMtime: 3000000,
      remoteMtime: 2000000,
    });

    expect(text).toContain('Local:');
    expect(text).toContain('Remote:');
  });

  it('says nothing when there is nothing to compare', () => {
    expect(describeAge({ state: LocalCopy.Missing })).toBe('');
  });
});
