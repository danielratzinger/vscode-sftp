/**
 * A row in the Remote Explorer offers `Reveal in Finder` once there is a local
 * copy of it - but what a row offers is decided when it is drawn, and nothing
 * drew it again after a download. The folder just brought down went on looking
 * as if it existed only on the server.
 */
jest.mock('vscode', () => {
  const URI = require('vscode-uri').default;

  class EventEmitter {
    fired: any[] = [];
    private listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    }
    fire(value: any) {
      this.fired.push(value);
      this.listeners.forEach(listener => listener(value));
    }
  }

  const nothing = jest.requireActual('../../../../__mocks__/vscode.js');
  const real: { [key: string]: any } = { Uri: URI, EventEmitter };

  return new Proxy(real, {
    get: (target, key: string) => (key in target ? target[key] : nothing[key]),
  });
}, { virtual: true });

jest.mock('../../serviceManager', () => ({ getAllFileService: () => services }));
jest.mock('../../worktreeSync', () => ({ autosyncState: () => undefined }));
// Read when a refresh asks for it, not when the mock is made: jest hoists this
// above the declarations below.
jest.mock('../../../app', () => ({
  __esModule: true,
  default: {
    get remoteExplorer() {
      return mockApp.remoteExplorer;
    },
  },
}));

import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { FileType, UResource } from '../../../core';
import RemoteTreeData from '../treeDataProvider';
import { refreshAfterDownload } from '../../../fileHandlers/shared';

let services: any[] = [];
const mockApp: any = {};

/** What the server has: a site with a folder that nobody has downloaded yet. */
const SERVER: { [dir: string]: Array<{ name: string; dir: boolean }> } = {
  '/httpdocs': [{ name: 'zng7.com', dir: true }],
  '/httpdocs/zng7.com': [
    { name: 'billapp', dir: true },
    { name: 'readme.txt', dir: false },
  ],
  '/httpdocs/zng7.com/billapp': [{ name: 'index.php', dir: false }],
};

function serviceAt(localBase: string) {
  return {
    id: 1,
    name: 'ratzinger.cc',
    baseDir: localBase,
    workspace: localBase,
    getConfig: () => ({ host: 'orbit.example', port: 2121, remotePath: '/httpdocs' }),
    getRemoteFileSystem: async () => ({
      list: async (dir: string) =>
        (SERVER[dir] || []).map(entry => ({
          fspath: `${dir}/${entry.name}`,
          name: entry.name,
          type: entry.dir ? FileType.Directory : FileType.File,
        })),
    }),
    getLocalFileSystem: () => ({
      lstat: async (file: string) => {
        const stat = await fse.lstat(file);
        return { type: stat.isDirectory() ? FileType.Directory : FileType.File };
      },
    }),
  };
}

function folderEvents(view: RemoteTreeData): any[] {
  return (view as any)._onDidChangeFolder.fired;
}

/** The paths a handler is given for a row, as the explorer hands it over. */
function targetFor(row: any, localBase: string): UResource {
  return UResource.from(row.resource.uri, {
    localBasePath: localBase,
    remoteBasePath: '/httpdocs',
    remote: { host: 'orbit.example', port: 2121 },
    remoteId: 1,
  });
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

let baseDir: string;
let tree: RemoteTreeData;
let rows: { [name: string]: any };

beforeEach(async () => {
  baseDir = fse.mkdtempSync(path.join(os.tmpdir(), 'reveal-after-download-'));
  services = [serviceAt(baseDir)];
  tree = new RemoteTreeData();
  mockApp.remoteExplorer = { refresh: (item: any) => tree.refresh(item) };

  // The rows the view has drawn: the site, opened two levels down.
  const [root] = await tree.getChildren();
  const [site] = await tree.getChildren(root);
  const [billapp, readme] = await tree.getChildren(site);
  rows = { root, site, billapp, readme };
  folderEvents(tree).length = 0;
});

afterEach(() => fse.remove(baseDir));

it('draws a folder again once it has been downloaded, so it offers to reveal it', async () => {
  expect(tree.getTreeItem(rows.billapp).contextValue).toBe('folder');

  // What the download leaves behind.
  fse.outputFileSync(path.join(baseDir, 'zng7.com/billapp/index.php'), '<?php');
  await refreshAfterDownload(targetFor(rows.billapp, baseDir), services[0] as any);
  await settle();

  // The folder it is in, which redraws its row, and its own row and listing -
  // the very rows the view has, not look-alikes it would not recognise.
  expect(folderEvents(tree)).toContain(rows.site);
  expect(folderEvents(tree)).toContain(rows.billapp);
  expect(tree.getTreeItem(rows.billapp).contextValue).toBe('folder-local');
  expect(tree.getTreeItem(rows.site).contextValue).toBe('folder-local');
});

it('draws the folder a downloaded file is in again', async () => {
  fse.outputFileSync(path.join(baseDir, 'zng7.com/readme.txt'), 'hello');
  await refreshAfterDownload(targetFor(rows.readme, baseDir), services[0] as any);
  await settle();

  expect(folderEvents(tree)).toEqual([rows.site]);
  expect(tree.getTreeItem(rows.readme).contextValue).toBe('file-local');
});

it('leaves the tree alone when nothing came down', async () => {
  await expect(
    refreshAfterDownload(targetFor(rows.billapp, baseDir), services[0] as any)
  ).resolves.toBeUndefined();
  await settle();

  expect(folderEvents(tree)).toEqual([]);
});
