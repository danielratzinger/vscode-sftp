import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import upath from '../src/core/upath';
import SFTPFileSystem from '../src/core/fs/sftpFileSystem';
import { startSftpServer, RunningServer } from './sftpServer';
import { createTools, ToolContext } from '../src/mcp/tools';

/**
 * A directory read a piece at a time over a real SFTP connection: what the
 * paged `list` rests on, including how the server says it is done.
 */

jest.setTimeout(60000);

let remote: RunningServer;
let serverRoot: string;
let fileSystem: SFTPFileSystem;
const COUNT = 2500;

beforeAll(async () => {
  serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-e2e-'));
  fse.ensureDirSync(path.join(serverRoot, 'tmp/compass'));
  for (let i = 0; i < COUNT; i++) {
    fs.writeFileSync(path.join(serverRoot, 'tmp/compass', `f${i}.css`), '');
  }

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
    operationTimeout: 10000,
  } as any);
  await fileSystem.connect((fileSystem as any).client._option, {
    askForPasswd: async () => undefined,
  });
});

afterAll(async () => {
  await remote.close();
  fse.removeSync(serverRoot);
});

it('hands a large directory over in pieces, then says it is done', async () => {
  const listing = await fileSystem.openListing('/tmp/compass');
  const first = await listing.read();

  expect(first!.length).toBeGreaterThan(0);
  expect(first!.length).toBeLessThan(COUNT);

  const names = new Set(first!.map(one => one.name));
  let piece;
  while ((piece = await listing.read())) {
    piece.forEach(one => names.add(one.name));
  }

  expect(names.size).toBe(COUNT);
  expect(names.has('.')).toBe(false);
  expect(await listing.read()).toBeUndefined();
  await listing.close();
});

it('can be closed early, and the connection carries on', async () => {
  const listing = await fileSystem.openListing('/tmp/compass');
  await listing.read();
  await listing.close();

  expect((await fileSystem.list('/tmp')).map(one => one.name)).toEqual(['compass']);
});

it('pages through it with the list tool, to the end, each page in time', async () => {
  const service: any = {
    id: 1,
    name: 'Fixture',
    workspace: serverRoot,
    baseDir: serverRoot,
    getConfig: () => ({
      name: 'Fixture',
      protocol: 'sftp',
      host: '127.0.0.1',
      port: remote.port,
      remotePath: '/',
    }),
  };
  const context: ToolContext = {
    services: () => [service],
    exposure: () => ({ exposedByDefault: true }),
    remoteFs: async () => fileSystem as any,
    cacheOption: () => ({ cacheRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'cache-')) }),
    callTimeout: () => 30000,
  } as any;
  const list = createTools(context).find(one => one.name === 'list')!;

  const seen = new Set<string>();
  let result: any = await list.run({ server: 'Fixture', path: '/tmp/compass' });
  let pages = 1;
  result.structured.entries.forEach((one: any) => seen.add(one.name));
  expect(result.structured.cursor).toBeTruthy();

  while (result.structured.cursor) {
    result = await list.run({
      server: 'Fixture',
      path: '/tmp/compass',
      cursor: result.structured.cursor,
    });
    pages += 1;
    result.structured.entries.forEach((one: any) => seen.add(one.name));
  }

  expect(seen.size).toBe(COUNT);
  expect(pages).toBe(3);
});
