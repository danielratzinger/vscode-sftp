import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import upath from '../src/core/upath';
import SFTPFileSystem from '../src/core/fs/sftpFileSystem';
import { createFile } from '../src/core/fileBaseOperations';
import { startSftpServer, RunningServer } from './sftpServer';

jest.setTimeout(30000);

let remote: RunningServer;
let serverRoot: string;
let fileSystem: SFTPFileSystem;

beforeAll(async () => {
  serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'create-e2e-'));
  remote = await startSftpServer(serverRoot);
  fileSystem = new SFTPFileSystem(upath, {
    clientOption: {
      host: '127.0.0.1',
      port: remote.port,
      username: 'tester',
      password: 'anything',
      connectTimeout: 10000,
      debug: () => undefined,
    } as any,
    operationTimeout: 3000,
  } as any);

  await fileSystem.connect(
    (fileSystem as any).client._option,
    { askForPasswd: async () => undefined }
  );
});

afterAll(async () => {
  await remote.close();
  fse.removeSync(serverRoot);
});

it('finishes creating an empty file', async () => {
  const done = createFile('/new.php', fileSystem, {}).then(() => 'done');
  const outcome = await Promise.race([
    done,
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 5000)),
  ]);

  expect(fs.existsSync(path.join(serverRoot, 'new.php'))).toBe(true);
  expect(outcome).toBe('done');
});
