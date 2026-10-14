jest.mock('vscode', () => {
  const URI = require('vscode-uri').default;
  const nothing = jest.requireActual('../../../__mocks__/vscode.js');
  const real: { [key: string]: any } = { Uri: URI };
  return new Proxy(real, { get: (t, k: string) => (k in t ? t[k] : nothing[k]) });
}, { virtual: true });

import { Uri } from 'vscode';
import { uriFromExplorerContextOrEditorContext } from '../shared';

/** What a command is handed, depending on where it was run from. */
describe('which file a command was run on', () => {
  // The palette: no item, so the command asks which connection instead.
  it('is none from the palette', () => {
    expect(uriFromExplorerContextOrEditorContext(undefined, undefined)).toBeUndefined();
    expect(uriFromExplorerContextOrEditorContext(null, [])).toBeUndefined();
  });

  it('is the file clicked in the file explorer', () => {
    const file = Uri.file('/work/site/a.php');
    expect(uriFromExplorerContextOrEditorContext(file, undefined)).toBe(file);
    // With the selection beside it, as the explorer passes it: the selection.
    expect(uriFromExplorerContextOrEditorContext(file, [file])).toEqual([file]);
  });

  it('is the entry clicked in the Remote Explorer', () => {
    const uri = Uri.parse('remote://host:22/a.php?remoteId%3D1%26fsPath%3D%252Fa.php');
    const item = { resource: { uri } };
    expect(uriFromExplorerContextOrEditorContext(item, undefined)).toBe(uri);
  });

  it('is every entry selected in the Remote Explorer', () => {
    const one = { resource: { uri: Uri.parse('remote://host:22/a?remoteId%3D1') } };
    const two = { resource: { uri: Uri.parse('remote://host:22/b?remoteId%3D1') } };
    expect(uriFromExplorerContextOrEditorContext(one, [one, two])).toEqual([
      one.resource.uri,
      two.resource.uri,
    ]);
  });

  it('is the one entry when the selection list is empty of entries', () => {
    const uri = Uri.parse('remote://host:22/a?remoteId%3D1');
    const item = { resource: { uri } };
    expect(uriFromExplorerContextOrEditorContext(item, [undefined])).toBe(uri);
  });
});
