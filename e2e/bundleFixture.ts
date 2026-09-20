/**
 * Loaded by `bundle.e2e.ts` after webpack has built it in production mode.
 *
 * It imports the extension's own entry first, so the modules initialise in the
 * order they do in the editor. That order is the whole point: the same code
 * rooted at a different entry hides the fault this guards against.
 */
import '../src/extension';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRemoteIfNoneExist, removeRemoteFs } from '../src/core/remoteFs';
import { startSftpServer } from './sftpServer';
import {
  FileSystem,
  LocalFileSystem,
  RemoteFileSystem,
  SFTPFileSystem,
  FTPFileSystem,
} from '../src/core/fs';

const CONTENT = '<?php echo "read through the bundle";';

const result: any = {
  barrel: {
    FileSystem: typeof FileSystem,
    LocalFileSystem: typeof LocalFileSystem,
    RemoteFileSystem: typeof RemoteFileSystem,
    SFTPFileSystem: typeof SFTPFileSystem,
    FTPFileSystem: typeof FTPFileSystem,
  },
  connect: {},
};

async function tryConnect(protocol: string, port: number, over: object = {}) {
  try {
    await createRemoteIfNoneExist({
      protocol,
      host: '127.0.0.1',
      port,
      username: 'u',
      password: 'p',
      remotePath: '/',
      connectTimeout: 1000,
      debug: () => undefined,
      ...over,
    } as any);
    return 'connected';
  } catch (error) {
    // A refused connection means everything before the socket worked, which
    // is what this is asking about.
    return error && error.message;
  }
}

/**
 * A real file, read over a real socket, through the bundle.
 *
 * Connecting is not enough. The read is the operation that encodes file
 * attributes, which is where ssh2 reaches for the `util.isDate` it captured
 * when it loaded - before `activate`, while these imports were still being
 * evaluated. Everything else about this bundle can be right and this one
 * thing still throw.
 */
async function readAFile(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-read-'));
  fs.writeFileSync(path.join(root, 'index.php'), CONTENT);
  const server = await startSftpServer(root);
  const option = {
    protocol: 'sftp',
    host: '127.0.0.1',
    port: server.port,
    username: 'tester',
    password: 'anything',
    remotePath: '/',
    connectTimeout: 10000,
    debug: () => undefined,
  };

  try {
    const fileSystem: any = await createRemoteIfNoneExist(option as any);
    const bytes = await Promise.race([
      // The server serves everything from inside its own root, so the path it
      // wants is the one below that root, not the one on this disk.
      fileSystem.readFile('/index.php'),
      // A read that fails inside the client can hang rather than throw, and a
      // fixture that waits for ever tells nobody anything.
      new Promise((_, stop) =>
        setTimeout(() => stop(new Error('the read never came back')), 10000)
      ),
    ]);
    return (bytes as Buffer).toString();
  } catch (error) {
    return `failed: ${error && error.message}`;
  } finally {
    removeRemoteFs(option);
    await server.close();
  }
}

async function main() {
  result.connect.sftp = await tryConnect('sftp', 1);
  // FTPS, so the cleartext check has nothing to say and the attempt reaches
  // the socket.
  result.connect.ftp = await tryConnect('ftp', 2, {
    secure: true,
    secureOptions: { rejectUnauthorized: false },
  });
  // Plain FTP, where it should stop before the socket. Nothing answers the
  // prompt here, which stands for someone declining it.
  result.connect.cleartextFtp = await tryConnect('ftp', 3, { host: '127.0.0.2' });

  result.read = await readAFile();

  // tslint:disable-next-line:no-console
  console.log(`__RESULT__${JSON.stringify(result)}`);
  process.exit(0);
}

main();
