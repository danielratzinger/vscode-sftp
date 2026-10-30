/**
 * Loaded by `bundle.e2e.ts` after webpack has built it in production mode.
 *
 * It imports the extension's own entry first, so the modules initialise in the
 * order they do in the editor. That order is the whole point: the same code
 * rooted at a different entry hides the fault this guards against.
 */
import '../src/extension';
import initCommands from '../src/initCommands';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { createRemoteIfNoneExist, removeRemoteFs } from '../src/core/remoteFs';
import { startSftpServer } from './sftpServer';
import { execFileSync } from 'child_process';
import { Uri } from 'vscode';
import { createFileService, disposeFileService } from '../src/modules/serviceManager';
import { uploadFolder } from '../src/fileHandlers';
import UResource from '../src/core/uResource';
import app from '../src/app';
import { ignoredOnRemote, missingLocally, rulesOf } from '../src/modules/remoteCleanup';
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

/**
 * A server that refuses the password, asked twice in a row - as autosync and a
 * retry would. The second must not reach it: refused logins in quick
 * succession are what hosts lock an address out for.
 */
async function refusedLogin(): Promise<any> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-refused-'));
  const server = await startSftpServer(root, { refuseLogins: true });
  const option = {
    protocol: 'sftp',
    host: '127.0.0.1',
    port: server.port,
    username: 'tester',
    password: 'the old one',
    remotePath: '/',
    connectTimeout: 10000,
    debug: () => undefined,
  };
  const attempt = () =>
    createRemoteIfNoneExist(option as any).then(
      () => 'connected',
      (error: any) => (error && error.message) || String(error)
    );

  try {
    const first = await attempt();
    const afterFirst = server.passwordAttempts();
    const second = await attempt();
    return { first, second, afterFirst, afterSecond: server.passwordAttempts() };
  } finally {
    removeRemoteFs(option);
    await server.close();
  }
}

/** Every file below a folder, relative to it, sorted. */
function filesBelow(root: string, at = ''): string[] {
  return fs
    .readdirSync(path.join(root, at))
    .reduce((all: string[], name) => {
      const relative = at ? `${at}/${name}` : name;
      return fs.statSync(path.join(root, relative)).isDirectory()
        ? all.concat(filesBelow(root, relative))
        : all.concat(relative);
    }, [])
    .sort();
}

/**
 * `Upload Folder` through the real handler, the real connection and a real
 * repository: once as it is now, leaving out what `.gitignore` and
 * `.git-ftp-ignore` exclude, and once in full. Then the two questions the
 * clean-up commands ask of the server.
 */
async function uploadIgnoring(): Promise<any> {
  // No tree outside the editor; a finished upload asks it to refresh.
  (app as any).remoteExplorer = { refresh: () => undefined };
  const local = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-ignore-local-')));
  const files: { [name: string]: string } = {
    '.gitignore': 'vendor/\n*.log\n.env\n',
    '.git-ftp-ignore': 'tests/\n',
    'index.php': '<?php',
    'src/a.php': '<?php',
    'src/debug.log': 'x',
    'vendor/psr/log.php': '<?php',
    'tests/aTest.php': '<?php',
    '.env': 'SECRET=1',
  };
  Object.keys(files).forEach(name => {
    fse.ensureDirSync(path.dirname(path.join(local, name)));
    fs.writeFileSync(path.join(local, name), files[name]);
  });
  execFileSync('git', ['init', '-q'], { cwd: local });

  const run = async (inFull: boolean) => {
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-ignore-remote-'));
    const server = await startSftpServer(remoteRoot);
    const service = createFileService(
      {
        protocol: 'sftp',
        host: '127.0.0.1',
        port: server.port,
        username: 'tester',
        password: 'anything',
        remotePath: '/',
        concurrency: 1,
        connectTimeout: 10000,
        verifyTransfer: true,
        useArchiveTransfer: true,
        ignore: [],
      },
      local
    );
    const config = service.getConfig();
    const context: any = {
      fileService: service,
      config,
      target: UResource.from(Uri.file(local), {
        localBasePath: local,
        remoteBasePath: '/',
        remoteId: service.id,
        remote: { host: config.host, port: config.port },
      }),
    };

    try {
      await uploadFolder(context, inFull ? { projectIgnore: false } : {});
      const uploaded = filesBelow(remoteRoot);

      // What is now on the server and only there, for the two finders.
      fs.writeFileSync(path.join(remoteRoot, 'only-on-server.txt'), 'x');
      fs.mkdirSync(path.join(remoteRoot, 'uploads'));
      fs.writeFileSync(path.join(remoteRoot, 'uploads', 'photo.jpg'), 'x');

      const walk = {
        context,
        progress: { report: () => undefined },
        token: { isCancellationRequested: false },
      } as any;
      const rules = await rulesOf(context);
      const ignored = (await ignoredOnRemote(walk, rules!)).map(one => one.label).sort();
      const onlyThere = (await missingLocally(walk)).map(one => one.label).sort();

      return { uploaded, ignored, onlyThere };
    } catch (error) {
      return { failed: error && error.stack };
    } finally {
      disposeFileService(service);
      await server.close();
    }
  };

  return { normal: await run(false), inFull: await run(true) };
}

/** Every command registered, as activation registers them, once each. */
function registerCommands() {
  initCommands({ subscriptions: [] } as any);
  const g: any = global;
  return {
    registered: (g.__registeredCommands || []).length,
    duplicates: g.__duplicateCommands || [],
  };
}

async function main() {
  result.commands = registerCommands();
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
  result.refused = await refusedLogin();
  result.ignoring = await uploadIgnoring();

  // tslint:disable-next-line:no-console
  console.log(`__RESULT__${JSON.stringify(result)}`);
  process.exit(0);
}

main();
