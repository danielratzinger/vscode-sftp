/**
 * Loaded by `bundle.e2e.ts` after webpack has built it in production mode.
 *
 * It imports the extension's own entry first, so the modules initialise in the
 * order they do in the editor. That order is the whole point: the same code
 * rooted at a different entry hides the fault this guards against.
 */
import '../src/extension';
import { createRemoteIfNoneExist } from '../src/core/remoteFs';
import {
  FileSystem,
  LocalFileSystem,
  RemoteFileSystem,
  SFTPFileSystem,
  FTPFileSystem,
} from '../src/core/fs';

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

  // tslint:disable-next-line:no-console
  console.log(`__RESULT__${JSON.stringify(result)}`);
  process.exit(0);
}

main();
