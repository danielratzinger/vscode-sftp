// Loads a webpack bundle of the extension outside VS Code, with just enough of
// the editor API stubbed for the modules to initialise.
const Module = require('module');
const util = require('util');

if (typeof util.isDate !== 'function') {
  util.isDate = value => value instanceof Date;
}

const nothing = () => undefined;
const disposable = { dispose: nothing };

const stub = new Proxy(
  {},
  {
    get(target, name) {
      switch (name) {
        case 'window':
          return {
            createOutputChannel: () => ({ appendLine: nothing, show: nothing, dispose: nothing }),
            createStatusBarItem: () => ({ show: nothing, hide: nothing, dispose: nothing, text: '' }),
            showErrorMessage: () => Promise.resolve(undefined),
            showWarningMessage: () => Promise.resolve(undefined),
            showInformationMessage: () => Promise.resolve(undefined),
            createTreeView: () => disposable,
            registerTreeDataProvider: () => disposable,
            onDidChangeActiveTextEditor: () => disposable,
            createTerminal: () => ({ sendText: nothing, show: nothing }),
          };
        case 'workspace':
          return {
            getConfiguration: () => ({ get: (key, fallback) => fallback }),
            workspaceFolders: [],
            onDidChangeConfiguration: () => disposable,
            onDidSaveTextDocument: () => disposable,
            onWillSaveTextDocument: () => disposable,
            onDidOpenTextDocument: () => disposable,
            onDidChangeWorkspaceFolders: () => disposable,
            createFileSystemWatcher: () => ({ onDidCreate: () => disposable, onDidChange: () => disposable, onDidDelete: () => disposable, dispose: nothing }),
            isTrusted: true,
          };
        case 'commands':
          return { registerCommand: () => disposable, executeCommand: () => Promise.resolve() };
        case 'extensions':
          return { getExtension: () => undefined };
        case 'Uri':
          return {
            file: p => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
            parse: s => ({ toString: () => s, fsPath: s, scheme: 'sftp' }),
          };
        case 'EventEmitter':
          return class {
            constructor() {
              this.event = () => disposable;
            }
            fire() {}
            dispose() {}
          };
        case 'StatusBarAlignment':
          return { Left: 1, Right: 2 };
        case 'TreeItemCollapsibleState':
          return { None: 0, Collapsed: 1, Expanded: 2 };
        case 'ThemeIcon':
        case 'TreeItem':
        case 'Disposable':
          return class {};
        case 'env':
          return { openExternal: nothing };
        default:
          return function () {};
      }
    },
  }
);

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  // The bundle keeps ssh2 external; resolve it from the project.
  if (request === 'ssh2') {
    return load.call(this, require.resolve('ssh2', { paths: [__dirname + '/..'] }), parent, isMain);
  }
  return load.apply(this, arguments);
};

require(process.argv[2]);
