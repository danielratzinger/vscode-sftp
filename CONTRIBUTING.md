# Contributing

This is a personal fork, developed for its own use. Issues and pull requests
are welcome but may sit for a while.

**If your change is a fix to the original extension** rather than to anything
added here, it is worth more upstream at
[Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), where
everyone else running this code will get it.

## Working on it

```bash
npm install
npm run dev     # webpack, watching
npm test        # unit suites
npm run e2e     # the whole stack against a real SFTP server
```

Press F5 in VS Code to launch an Extension Development Host with the extension
loaded.

Before opening a pull request:

- `npm test` and `npm run e2e` both pass
- `npx webpack --mode development` compiles with no errors
- `npx tslint -c tslint.json 'src/**/*.ts'` is clean for the files you touched

## What the tests are for

The unit suites stop at the file system interface and hand the code a fake
server, which is why `npm run e2e` exists: it starts a real SFTP server inside
the test process and drives the whole stack against it, including the cases
that cannot be produced by hand — a command that never answers, and a transfer
that goes quiet halfway through a file. A change to the transfer or connection
layer should come with a test there, not only in the unit suites.

## Style

Follow what is already in the file you are editing. Comments explain why
something is the way it is, especially where the obvious approach was tried
and did not work — those notes are the ones that stop the next person undoing
a fix by accident.
