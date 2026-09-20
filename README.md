# SFTP for VS Code

Edit a project locally and keep it in step with a remote server over SFTP or
FTP — upload on save, download a whole project, browse the remote tree in the
sidebar, diff local against remote — and, since this fork, let a local AI
client read those servers directly through an MCP server that runs inside the
editor.

## Where this comes from

The extension was written by [@liximomo](https://github.com/liximomo/vscode-sftp),
and kept alive for years afterwards by
[@Natizyskunk](https://github.com/Natizyskunk/vscode-sftp), whose fork is the
one most people have installed and the one this is built on. Almost everything
below the changes listed here is their work. If the extension has saved you
time, that is who to thank — and Natizyskunk accepts
[support](https://www.buymeacoffee.com/Natizyskunk) for the years of
maintenance.

This fork exists because a particular set of problems needed solving —
transfers that were slower than they should be, passwords sitting in a file in
the repository, and an agent that could not see the server it was working on.
It is developed for its own use and published nowhere; there is no marketplace
listing and no release channel.

## What is different here

**An MCP server inside the editor.** The connections already configured in
`sftp.json` are offered to any MCP client on the machine — Claude Desktop and
anything else that speaks the protocol — as twelve read-only tools: list a
directory, read a file, search the server's text, walk the tree with a note
about what each file is for, compare versions, and so on. Every path is
bounded by the connection's own root, credentials are removed before anything
is returned, and connections are exposed only if you say so. See
[docs/commands.md](./docs/commands.md#mcp-for-ai-clients).

**Continuous deploy from a folder you choose.** `SFTP: Autosync Worktree`
keeps a folder on the server as it changes — saved in this window or written
by anything else. Usually that folder is not the one the editor has open: an
agent working on a branch gets its own checkout, and where the tooling clones
rather than adds a worktree, git records nothing relating the two. So the
other checkouts are found — worktrees from git's metadata, clones by the
remote they came from — and listed by which was written in most recently. What
goes up is what git would keep, so `npm install` in a watched checkout does
not deploy `node_modules`. What leaves the branch is removed from the server.
Nothing is dropped: a failed upload waits and is tried again, and what is
still waiting when the window closes is picked up when it opens. One writer
per connection, across windows as well as within one. See
[docs/commands.md](./docs/commands.md#autosync-worktree).

**Cleaning up what a server accumulated.** `SFTP: Remove Files Deleted from
the Project` asks git what the project has dropped over its history and offers
to take those files off the server — downloads write and never remove, and a
deploy uploads what exists rather than removing what stopped existing. Only
paths git once tracked are ever named, so a runtime directory, upload folder
or cache the repository ignores cannot appear in the list. That is the
difference from `Sync Local -> Remote` with `syncOption.delete`, which lists
the server and removes whatever is not on this machine.

**A way back from a bad deploy.** Before autosync first writes over a file it
fetches what the server had and keeps it, once per file per session; if the
server cannot be reached to make that copy, the file is not overwritten.
`SFTP: Restore Server to an Earlier Point` puts a server back to how it was
before a session started.

**Host keys are checked.** Every connection here authenticates with a password
out of `sftp.json`, and until now the extension checked nothing — whatever
answered on port 22 got it. `~/.ssh/known_hosts` is read first, so a host you
have already accepted in a terminal is not asked about again; an unknown host
shows its fingerprint once; a key that has changed is refused, with the option
to update the stored one.

**Transfers that use the bandwidth.** FTP opens a pool of control connections
rather than moving one file at a time; SFTP uses pipelined transfers instead
of one request in flight. Every transfer is retried on a transient failure and
checked by size before a temp file replaces a real one.

**Nothing waits forever.** A command must answer within `operationTimeout`; a
transfer is watched for silence rather than given a deadline, because a large
file on a slow line legitimately takes as long as it takes. A connection that
stalls is retired rather than handed to the next caller.

**Passwords out of `sftp.json`.** A password or passphrase can live in the
editor's secret store, in the macOS keychain, or behind a command such as
`op read`, and a literal password already in the file can be migrated into any
of them. See [passwordManager](./docs/common_configuration.md#passwordmanager).

**Care around downloads.** A download that would overwrite newer local work
asks first and offers a diff; whatever it replaces is kept and can be restored
from the command palette, because VS Code's own local history does not record
what an extension writes.

**Files worth reading.** `SFTP: Download Scripts` fetches the text of a
project — source, JSON, Markdown, templates, configuration — and leaves the
media and archives behind.

**Getting out of the editor.** `Reveal in Terminal` opens a folder in the
machine's own terminal rather than the built-in one; `Reveal in Finder` shows
the local copy in the system's file manager. Both appear only where there is
something on disk to open.

**Starting again.** `Clear Local Folder` deletes the local copy of a folder so
a download can start from nothing — downloads write files and never remove
them, so a folder fetched across a year of deploys holds files the server
deleted months ago. It asks first, moves what it removes to the trash, and is
not offered on anything inside a repository.

**Hidden files and server clocks.** FTP listings ask for hidden files and fall
back gracefully when the server does not understand the flag; a server whose
clock disagrees with this machine is measured once and corrected for, so
timestamp comparisons mean something.

## Installing

There is no marketplace listing. Build it:

```bash
npm install
npm run compile
npx vsce package
```

Then in VS Code: **Extensions → ⋯ → Install from VSIX…** and pick the file.

The extension id is `danielratzinger.sftp`, so it installs beside the
marketplace SFTP extension rather than replacing it. **Disable the other one**
— disabling is enough, and there is nothing to migrate: both read the same
`sftp.*` settings and the same `.vscode/sftp.json`, so every server you have
configured already works here. Leaving both enabled means two extensions
answering the same commands and the same `uploadOnSave`, which uploads twice;
this extension says so at startup if it finds one.

## Getting started

1. Open the folder you want to sync.
2. Run **SFTP: Config** from the command palette. A `sftp.json` appears under
   `.vscode`.
3. Fill in the server:

```json
{
  "name": "Staging",
  "host": "staging.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "deploy",
  "passwordManager": "keychain",
  "remotePath": "/srv/app",
  "uploadOnSave": false
}
```

4. Run **SFTP: Download Project** to pull the remote directory down, or start
   editing and let `uploadOnSave` push changes up.

Leave the password out and you will be asked for it; name a
[passwordManager](./docs/common_configuration.md#passwordmanager) and the
answer is kept somewhere better than a file in your repository.

## Documentation

- [Settings](./docs/setting.md)
- [Configuration](./docs/configuration.md) — every option in one place
  - [Common](./docs/common_configuration.md)
  - [SFTP only](./docs/sftp_configuration.md)
  - [FTP only](./docs/ftp_configuration.md)
- [Commands](./docs/commands.md) — including the MCP tools, what they refuse,
  and how to connect a client
- [FAQ](./FAQ.md)
- [MCP-DESIGN.md](./MCP-DESIGN.md) — why the MCP server is built the way it is

## Remote Explorer

![remote-explorer-preview](https://raw.githubusercontent.com/Natizyskunk/vscode-sftp/master/assets/showcase/remote-explorer.png)

Browse the server without downloading it: run **View: Show SFTP**, or click
SFTP in the activity bar. Files open read-only; **SFTP: Edit in Local** brings
one down to edit. Multiple selection works with Ctrl or Shift, and
`remoteExplorer.order` sets where a connection appears.

## Example configurations

### Simple

```json
{
  "host": "host",
  "username": "username",
  "remotePath": "/remote/workspace"
}
```

### Profiles

```json
{
  "username": "username",
  "password": "password",
  "remotePath": "/remote/workspace/a",
  "watcher": {
    "files": "dist/*.{js,css}",
    "autoUpload": false,
    "autoDelete": false
  },
  "profiles": {
    "dev": {
      "host": "dev-host",
      "remotePath": "/dev"
    },
    "prod": {
      "host": "prod-host",
      "remotePath": "/prod"
    }
  },
  "defaultProfile": "dev"
}
```

Switch with **SFTP: Set Profile**.

### Multiple contexts

```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/workspace/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/workspace/src"
  }
]
```

### Connection hopping

```json
{
  "host": "targetHost",
  "username": "targetUser",
  "privateKeyPath": "/Users/targetUser/.ssh/id_rsa",
  "remotePath": "/path/to/remote/directory",
  "hop": {
    "host": "hopHost",
    "username": "hopUser",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa"
  }
}
```

`hop` also takes an array, applied in order, for more than one jump.

## Debugging

Set `sftp.debug` to `true` in your settings and reload. The log is in
**View → Output → sftp**, and every MCP tool call is logged there too — which
is how you see what an agent actually read, rather than what it says it read.

Each line says which connection it is about — `[info:staging]`, by the `name`
in `sftp.json` or the host if it has none — so a timeout or a clock warning
belongs to a server rather than to the extension in general.

## Testing

```bash
npm test      # unit suites
npm run e2e   # a real SFTP server, in-process, driven end to end
```

The second one exists because the first stops at the network: it starts a real
SFTP server inside the test process and drives the whole stack against it,
including a command that never answers and a transfer that goes quiet halfway
through a file.

## License

MIT, as it has been since liximomo wrote it. See [LICENSE](./LICENSE), which
carries the copyright of everyone whose work is in here.
