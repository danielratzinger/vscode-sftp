/**
 * A file created or uploaded through the Remote Explorer has to appear without
 * refreshing its folder by hand. What hid it: the tree is asked to refresh the
 * new file's folder, and finds no connection for it - because the connections
 * were rebuilt since the tree last built its rows - and so refreshed nothing.
 */
jest.mock('vscode', () => {
  const URI = require('vscode-uri').default;

  class EventEmitter {
    fired: any[] = [];
    private listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this.listeners.push(listener);
      return { dispose() {} };
    };
    fire(value: any) {
      this.fired.push(value);
      this.listeners.forEach(listener => listener(value));
    }
  }

  // Everything else the modules on the way touch at load time answers as the
  // project's own stand-in does: harmlessly, with nothing.
  const nothing = jest.requireActual('../../../../__mocks__/vscode.js');
  const real: { [key: string]: any } = { Uri: URI, EventEmitter };

  return new Proxy(real, {
    get: (target, key: string) => (key in target ? target[key] : nothing[key]),
  });
}, { virtual: true });

jest.mock('../../serviceManager', () => ({ getAllFileService: () => services }));
jest.mock('../../worktreeSync', () => ({ autosyncState: () => undefined }));

import { UResource } from '../../../core';
import RemoteTreeData from '../treeDataProvider';

let services: any[] = [];

function service(id: number, remotePath = '/httpdocs') {
  return {
    id,
    name: `site-${id}`,
    baseDir: `/work/site-${id}`,
    getConfig: () => ({ host: 'orbit.example', port: 2121, remotePath }),
  };
}

/** What the explorer hands over after creating `name` under the root. */
function created(remoteId: number, file: string) {
  return {
    resource: UResource.makeResource({
      remote: { host: 'orbit.example', port: 2121 },
      fsPath: file,
      remoteId,
    }),
    isDirectory: false,
  };
}

function folderEvents(tree: RemoteTreeData): any[] {
  return (tree as any)._onDidChangeFolder.fired;
}

describe('refreshing after something was created', () => {
  beforeEach(() => {
    services = [service(1)];
  });

  it('refreshes the folder it was created in', async () => {
    const tree = new RemoteTreeData();
    const [root] = await tree.getChildren();

    await tree.refresh(created(1, '/httpdocs/new.php'));

    expect(folderEvents(tree)).toEqual([root]);
  });

  // The tree was refreshed as a whole - a sftp.json saved - and the view has
  // not asked for its rows yet when the file is created.
  it('still finds the connection before the view has asked again', async () => {
    const tree = new RemoteTreeData();
    await tree.getChildren();
    await tree.refresh();
    folderEvents(tree).length = 0;

    await tree.refresh(created(1, '/httpdocs/new.php'));

    expect(folderEvents(tree)).toHaveLength(1);
    expect(folderEvents(tree)[0]).toBeDefined();
  });

  // The connections were rebuilt with new ids and nobody told the tree.
  it('refreshes the whole tree for a connection it does not know', async () => {
    const tree = new RemoteTreeData();
    await tree.getChildren();
    services = [service(2)];

    await tree.refresh(created(2, '/httpdocs/new.php'));

    expect(folderEvents(tree)).toEqual([undefined]);
    const [root] = await tree.getChildren();
    expect((root as any).explorerContext.id).toBe(2);
  });
});

describe('refreshing a folder', () => {
  beforeEach(() => {
    services = [service(1)];
  });

  function folder(remoteId: number, fsPath: string) {
    return { ...created(remoteId, fsPath), isDirectory: true };
  }

  // An upload into the root hands over a fresh object for the root; the view
  // only knows the one it was given.
  it('refreshes the row the view has, not a look-alike', async () => {
    const tree = new RemoteTreeData();
    const [root] = await tree.getChildren();

    await tree.refresh(folder(1, '/httpdocs')).catch(() => undefined);

    expect(folderEvents(tree)[0]).toBe(root);
  });

  // A folder just uploaded has no row yet; the one it appeared in does.
  it('refreshes where a new folder appeared', async () => {
    const tree = new RemoteTreeData();
    const [root] = await tree.getChildren();

    await tree.refresh(folder(1, '/httpdocs/uploaded'));

    expect(folderEvents(tree)).toEqual([root]);
  });
});
