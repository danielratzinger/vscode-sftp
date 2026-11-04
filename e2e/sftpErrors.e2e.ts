import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import upath from '../src/core/upath';
import SFTPFileSystem from '../src/core/fs/sftpFileSystem';
import { startSftpServer, RunningServer } from './sftpServer';

/**
 * What a real SFTP server's refusal looks like by the time it reaches the log:
 * the operation and the path, which a folder transfer of thousands of files
 * otherwise left out.
 */

jest.setTimeout(30000);

let server: RunningServer;
let fileSystem: any;

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-errors-e2e-'));
  server = await startSftpServer(root);
  fileSystem = new SFTPFileSystem(upath, {
    clientOption: {
      host: '127.0.0.1',
      port: server.port,
      username: 'tester',
      password: 'anything',
      connectTimeout: 10000,
      debug: () => undefined,
    } as any,
    operationTimeout: 5000,
  } as any);
  await fileSystem.connect(fileSystem.client._option, { askForPasswd: async () => undefined });
});

afterAll(async () => {
  fileSystem.end();
  await server.close();
});

it('names the folder a listing failed on', async () => {
  const error = await fileSystem.list('/not/here').catch((e: any) => e);
  expect(error.message).toMatch(/could not list \/not\/here/);
  expect(error.code).toBe(2);
});

it('names the file a download failed on, through the stream', async () => {
  const stream = await fileSystem.get('/missing.txt');
  const error: any = await new Promise(resolve => {
    stream.on('error', resolve);
    stream.resume();
  });
  expect(error.message).toMatch(/could not download \/missing\.txt/);
});

it('names the file a direct download failed on', async () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'x');
  const error = await fileSystem.downloadToLocal('/missing.txt', target).catch((e: any) => e);
  expect(error.message).toMatch(/could not download \/missing\.txt/);
});
