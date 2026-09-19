jest.mock('fs');

import { vol } from 'memfs';
import * as path from 'path';
import { transfer, TransferDirection } from '../transfer';
import localFs from '../../../core/localFs';
import RemoteFs from '../../../../test/helper/localRemoteFs';
import {
  DEFAULT_EXCLUDED_EXTENSIONS,
  isInExcludedFolder,
  isScriptFile,
} from '../../../core/scriptFiles';

/** What someone would put in sftp.downloadScripts.excludeFolders. */
const EXCLUDED_FOLDERS = ['node_modules', '.git', 'dist'];

const remoteFs = new RemoteFs(path, { client: {} as any });
const ROOT = '/remote/site';

function collectNames(option: object): Promise<string[]> {
  const names: string[] = [];

  return transfer(
    {
      srcFsPath: ROOT,
      targetFsPath: '/local/site',
      srcFs: remoteFs as any,
      targetFs: localFs,
      transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      transferOption: option as any,
    },
    task => names.push(task.srcFsPath.slice(ROOT.length + 1))
  ).then(() => names.sort());
}

/** What the command builds out of the box: file types only, no folder list. */
const scriptsOption = {
  perserveTargetMode: false,
  fileFilter: (fsPath: string) =>
    isScriptFile(fsPath, DEFAULT_EXCLUDED_EXTENSIONS),
};

/** And with folders named in the setting. */
const withExcludedFolders = {
  ...scriptsOption,
  ignore: (fsPath: string) => isInExcludedFolder(fsPath, EXCLUDED_FOLDERS, ROOT),
};

describe('Download Scripts', () => {
  beforeEach(() => {
    vol.reset();
    vol.fromJSON({
      '/remote/site/index.php': '<?php',
      '/remote/site/package.json': '{}',
      '/remote/site/README.md': '# hi',
      '/remote/site/src/app.ts': 'code',
      '/remote/site/src/styles.css': 'css',
      '/remote/site/src/page.html': '<html>',
      '/remote/site/public/logo.png': 'binary',
      '/remote/site/public/font.woff2': 'binary',
      '/remote/site/public/icon.svg': '<svg>',
      // A folder with a dot in its name must still be walked.
      '/remote/site/assets.min/app.js': 'code',
      // Machinery: skipped whole.
      '/remote/site/node_modules/react/index.js': 'code',
      '/remote/site/.git/config': 'config',
      '/remote/site/dist/bundle.js': 'built',
      '/local/site/.keep': '',
    });
  });

  it('takes the code, the markup, the styles, the config and the docs', async () => {
    const names = await collectNames(scriptsOption);

    [
      'README.md',
      'assets.min/app.js',
      'index.php',
      'package.json',
      'public/icon.svg',
      'src/app.ts',
      'src/page.html',
      'src/styles.css',
    ].forEach(name => expect(names).toContain(name));
  });

  it('leaves the binaries behind', async () => {
    const names = await collectNames(scriptsOption);

    ['public/logo.png', 'public/font.woff2'].forEach(name =>
      expect(names).not.toContain(name)
    );
  });

  it('walks every folder unless the setting names one', async () => {
    const names = await collectNames(scriptsOption);

    // No folder list configured, so dependencies and build output come too.
    expect(names).toContain('node_modules/react/index.js');
    expect(names).toContain('dist/bundle.js');
    expect(names).toContain('.git/config');
  });

  it('skips the folders the setting names', async () => {
    const names = await collectNames(withExcludedFolders);

    expect(names).toContain('src/app.ts');
    ['node_modules/', '.git/', 'dist/'].forEach(prefix =>
      expect(names.some(name => name.startsWith(prefix))).toBe(false)
    );
  });

  it('downloads the excluded folder you asked for by name', async () => {
    const root = '/remote/site/dist';
    const names: string[] = [];

    await transfer(
      {
        srcFsPath: root,
        targetFsPath: '/local/dist',
        srcFs: remoteFs as any,
        targetFs: localFs,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: {
          perserveTargetMode: false,
          ignore: (fsPath: string) =>
            isInExcludedFolder(fsPath, EXCLUDED_FOLDERS, root),
          fileFilter: (fsPath: string) =>
            isScriptFile(fsPath, DEFAULT_EXCLUDED_EXTENSIONS),
        } as any,
      },
      task => names.push(task.srcFsPath)
    );

    expect(names).toEqual(['/remote/site/dist/bundle.js']);
  });

  it('would collect nothing at all if the root excluded itself', async () => {
    // transferFolder tests `ignore` against the folder it is given, the
    // top-level one included, and returns immediately when it matches. So an
    // exclusion that hits the root aborts the whole walk, silently.
    const root = '/remote/site/dist';
    const names: string[] = [];

    await transfer(
      {
        srcFsPath: root,
        targetFsPath: '/local/dist',
        srcFs: remoteFs as any,
        targetFs: localFs,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: {
          perserveTargetMode: false,
          // No root passed: `dist` matches a segment of the root itself.
          ignore: (fsPath: string) =>
            isInExcludedFolder(fsPath, EXCLUDED_FOLDERS),
        } as any,
      },
      task => names.push(task.srcFsPath)
    );

    expect(names).toEqual([]);
  });

  it('still downloads everything without the filter', async () => {
    const names = await collectNames({ perserveTargetMode: false });

    expect(names).toContain('public/logo.png');
    expect(names).toContain('node_modules/react/index.js');
  });
});
