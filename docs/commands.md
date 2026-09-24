## Common commands

### SFTP: Config
Create a new configuration file for a project.

### SFTP: Set Profile
Set the current profile.
           
#### KeyBindings Args
func(profileName: string)

### SFTP: Upload Active File
Upload the current file.

### SFTP: Upload Changed Files
Upload all files changed or created since the last commit to your Git.
Can be called by default keyboard shortcut `Ctrl+Alt+U`.

### SFTP: Upload Active Folder
Upload the entire folder the current file is located in.

### SFTP: Download Active File
Download the remote version of the current file and overwrite the local copy.

### SFTP: Download Active Folder
Download the entire folder the current file is located in.

### SFTP: Sync Local -> Remote
1. Any files that exist on both local and remote that have a different timestamp between local and remote are copied over.
2. Any files that only exist on the local are copied over.

You can change the default behavior by [syncOption](./common_configuration.md#syncoption).

### SFTP: Sync Remote -> Local
Same as `Sync Local -> Remote`, but in the opposite direction.

### SFTP: Sync Both Directions
Compare file modification times, and will always perform the action that causes the newest file to be present in both locations.

*Only [skipCreate](./common_configuration.md#syncoptionskipcreate) and [ignoreExisting](./common_configuration.md#syncoptionignoreexisting) are valid for this command.*

### SFTP: List Active Folder
List the folder the current file is located in.

### sftp.upload
Upload file or folders.

#### KeyBindings Args
func(fspaths: string[])

### sftp.download
Download file or folders.

#### KeyBindings Args
func(fspaths: string[])

### Download Scripts
Sits under `Download Folder` in the context menu, on folders. Downloads the folder the way `Download Folder` does, but only the files worth having as text: sources, markup, styles, config, data and docs. Images, media, fonts, archives, binaries and office documents are skipped.

The point is to end up with a copy of the codebase you can read and search — or hand to a coding agent — without dragging down a folder of video.

VS Code has no notion of a "script": it knows language identifiers such as `php` or `shellscript`, but nothing marks a language as code rather than a document, and the set of useful text formats is open ended. So the rule is the other way round — take everything, and name what is no use as text.

`sftp.downloadScripts.excludeExtensions` is that list. It takes an extension — `png`, `.png` and `*.png` all mean the same — or a whole file name, for files like `Thumbs.db`. Left empty it falls back to a built-in list covering images, media, fonts, archives, binaries and office documents.

Every folder is walked by default. To leave some out, name them in `sftp.downloadScripts.excludeFolders`, which matches a folder by name at any depth and skips everything inside it:

```json
{
  "sftp.downloadScripts.excludeFolders": ["node_modules", "vendor", ".git", "dist"]
}
```

| ⚠️ Warning |
| :--- |
| *That setting starts empty, so a download from a project root includes `node_modules`, `vendor` and build output — which after the rule above are almost entirely text files, and so are almost entirely kept. Worth filling in before pointing this at a large project.* | 

| 💡 Note |
| :--- |
| *The folder you ask for is always downloaded, even if its name is in `excludeFolders` — right-clicking `dist` and asking for its scripts gives you `dist`. Only folders below it are skipped. A folder with a dot in its name is still a folder, so a file inside `assets.min/` is found.* | 

Both settings ignore case. The connection's own `ignore` rules still apply on top.

### Reveal in Finder
Sits above `Reveal in Explorer` in the Remote Explorer's menu, on anything that has been downloaded — and only then, because there is nothing to show otherwise. `Reveal in Explorer` shows the file in the editor's own sidebar; this opens the system's file manager, which is where you go for what the editor does not do: a Quick Look, a drag into another application, a look at what else is in the folder.

It is called `Reveal in Finder` on macOS, `Reveal in File Explorer` on Windows and `Open Containing Folder` on Linux, which is how the editor names its own. A menu entry shows its command's title and a title cannot vary by platform, so there is one command per platform behind it.

### Reveal in Terminal
On folders, in both explorers: opens the machine's own terminal on that folder — the external one, not the editor's built-in. In the Remote Explorer it needs a local copy, like `Reveal in Finder`; in the file explorer the folder is already there.

`openInTerminal` is the editor's command for the external terminal and `openInIntegratedTerminal` for the built-in one. They are separate commands, so `terminal.explorerKind` — which decides which of the two the *editor* offers in its own menus — does not redirect this one. Whatever is set in `terminal.external.osxExec`, `terminal.external.windowsExec` or `terminal.external.linuxExec` is the terminal that opens.

### Autosync Worktree
On a connection in the Remote Explorer, on a folder in the file explorer, or from the palette. Asks which folder this connection should deploy from, and then uploads everything that changes there — saved in this window or written by anything else. `Stop Autosync Worktree` sits beside it and appears only while something is syncing.

`Switch Autosync Worktree` takes its place while that connection is syncing, beside `Stop` — the same picker under the name that fits once something is running. Two commands rather than one whose title changes, because a menu entry shows its command's title and a title is fixed.

In the Remote Explorer this is decided **per connection**, not per window: the tree item carries whether that connection is syncing, so a workspace with twenty-eight connections does not label all of them by what one of them is doing. `Stop` and the reveal commands are precise the same way.

The file explorer has no per-item handle — it is the editor's own tree, and all a `when` clause can read there is window-wide. So it carries exactly one entry, `Autosync Worktree`, offered **always**: it is the only one that is right whatever is happening, because it opens the picker for whichever connection you clicked, and that picker already contains `Stop syncing` when that connection is the one running.

`Stop`, `Switch` and the reveal commands are not there at all. Each is about one connection, while the only thing a clause can read says whether *something* in the window is syncing — so they appeared on every project, including ones that were not syncing, where all they could do was say so. They live in the Remote Explorer, where the tree item says which connection it is.

Where the project is a git repository the folders on offer are its worktrees, which is the case this was built for: an agent working on a branch gets its own checkout, usually nowhere near the workspace. Where it is not a repository — which is most connections — there is one candidate, the project folder itself, and choosing it is how you say "keep this on the server" without writing a `watcher` block into `sftp.json`.

The list of worktrees comes from git's own metadata under `.git/worktrees` — every checkout of the repository, with the branch each is on, whether or not it is open in an editor. Nothing is scanned for and `git` need not be on the PATH.

Clones are found too, because not all tooling adds a worktree — some of it clones the repository instead, and a clone is unrelated to yours as far as git is concerned: separate `.git`, separate everything, nothing recording that they are the same project. What relates them is the remote they came from, so that is what is matched, normalised — `https://github.com/x/y.git` and `git@github.com:x/y` are the same repository. Each clone's own worktrees then come from its metadata, exactly, as this one's do.

Two kinds git reports are left out, with the count shown. A checkout sitting on a **commit rather than a branch**: nothing tracks it, so there is no branch to keep the server on and no git catch-up to offer, only the time-window one. And a checkout **nested inside another one's `.git`, `.vscode` or `.claude`**: the thing deployed there is the checkout around it, which is why those folders are never uploaded in the first place. Agent tooling leaves a lot of both behind — on one real project, four out of six.

That second test is made against the other candidates rather than by looking for `.claude` in the path, so a project that happens to sit under a folder of that name is not caught by it. `sftp.autosync.showEveryCheckout` brings both kinds back; the folder this window has open is always offered whatever state it is in. A detached checkout that is shown is labelled by its folder and says `detached`, because a folder name where a branch name goes reads as a branch.

That part is a search rather than a lookup, so it is bounded on every axis: the folder holding the project plus whatever `sftp.autosync.searchPaths` names, three levels deep, skipping `node_modules` and its kind, and only ever run when you open the list. Add the folder your tooling clones into — `~/intent/workspaces`, say — if it is not beside the project.

The list is ordered by which folder was written in most recently, and says so: `edited just now`, `edited 3 hours ago`. That is the question behind it — which checkout is being worked in — and the answer is an indication rather than a record, which is why the time is shown and not only the order. It is read from the files, bounded the same way, and the folder each entry is in is under the branch name.

**One writer.** A connection has one remote path, so it syncs from exactly one folder at a time. While it does, `uploadOnSave` for that connection stands down — two mechanisms uploading the same save is one upload too many, and the watcher sees everything a save does and more. The cost is that a save goes up when it has settled rather than the instant it is written. The log says so once rather than leaving you to wonder. `Stop Autosync Worktree`, or `Stop syncing` in the picker, hands it back.

When the folder being synced is **another one** — a worktree this window does not have open — nothing would ever send a save made here, so with `uploadOnSave` on, each save asks whether to upload it instead. The question is a notification rather than a dialog, so auto-save does not take the keyboard, and saving again while it is showing does not stack another; `Upload` sends whatever is on disk when you answer. The status bar still shows the synced folder's own transfers — those are real, just not yours.

**What is uploaded is what git would keep.** A watcher is not upload-on-save: it sees every write by every process, so `npm install` in a watched checkout is forty thousand files heading for the server unless something stops them — and most `sftp.json` files have no `ignore` list at all. So git is asked, with `git check-ignore`, which consults the index and therefore never reports a tracked file as ignored. It is asked once per batch rather than once per file, and once per directory rather than once per file under it: everything below `node_modules` is settled by one answer about `node_modules`. The connection's own `ignore` rules still apply on top, and `.git` is never uploaded. One edge is given up deliberately — a file force-added inside an ignored directory is treated as ignored, because git says the directory is.

**It survives quitting the editor.** Which folder a connection deploys from is remembered, and the watcher is set up again when the window comes back — after the connections exist, which is later than the extension starts and again every time `sftp.json` is saved. What was still queued is picked up and you are told it is being resumed.

And what changed while nothing was watching is caught up on. A mark is moved forward every thirty seconds while a connection is syncing, and on resume the folder is asked what has been written since — the same question the time-window catch-up asks, against a moment that was recorded rather than chosen. Those files are queued and a notice says how many, with a `Stop` button that clears them before much has moved. Uploads only: a file deleted while the window was closed leaves nothing behind to notice.

**The log is the transfer log.** Autosync uploads go through the connection's own transfer machinery, so each one writes the same `local ➞ remote /path` line to the SFTP output panel and moves the status bar exactly as a save does, carrying the connection name like every other line. There is no separate autosync log to go looking for. What autosync adds are the lines around it: which folder it started on, how many files a catch-up moved, how many are waiting to be retried, and deletions — which go through a handler that says nothing of its own.

A failed upload is written down but does not raise a dialog, because the queue is going to try it again in a few seconds and a dialog per attempt per file would bury the editor. The status bar still says `failed`, and the line is in the panel. Catch-ups and restores are the same: one thing said at the end rather than one per file.

**It keeps looking for somewhere busier.** While a connection is autosyncing, once a minute it asks the same question the picker answers: is another checkout of this project being written in more recently than the one going to the server? If one is, it offers to switch — `Sync it instead` — naming both and how long ago each was touched.

That replaced watching for a worktree to be *created*, which missed the case that actually happens: an agent picks up a checkout that already existed, so nothing is created and nothing fires.

Only while already autosyncing, because “deploy this one instead” needs something to be instead of. Only about checkouts the picker would offer, so the same two kinds are left out — detached, and nested in another checkout's scratch folder. Only when the other one was touched within the last half hour, since a checkout edited last week is not where the work is however it compares. And once per checkout: deciding not to switch is an answer, not something to ask again in a minute.

It looks at everything the picker does — the worktrees of the checkout being deployed and the clones of it — not only the repository this window has open. Those are often different: the checkout in the window may have no worktrees at all while every one of them belongs to a clone somewhere else, which is the arrangement agent tooling produces and the case this exists for.

**One writer, across windows as well as within one.** Inside a window a connection holds one folder and choosing another replaces it. Between windows that was not enforced at all: two editors share the store that says what is syncing but get no word when the other changes it, so both would watch, and if they were pointed at different checkouts both would write to the same remote path. There is now a claim file per connection, in the extension's storage — taken when a window starts syncing, touched every ten seconds, and treated as abandoned after forty. A window that cannot take it asks whether to take it over; the window that loses it stands down within a few seconds and says so. Same idea as `autosync.sh`'s pidfile, in the one place every window can see.

**`.git`, `.vscode` and `.claude` are never uploaded**, whatever git or your `ignore` rules say. `.vscode` because it holds `sftp.json`, which holds the password for the very server this would put it on — relying on that being gitignored is relying on somebody having remembered. `.claude` because it is an agent's workspace, worktrees and all, and none of it is the deployment.

**Deletions follow git's index, not the filesystem.** A file disappearing is not by itself a reason to take it off a live server — a build clears a folder, an editor swaps a file out and back, a branch switch rewrites half the tree. What git's index says is different: a file that has left `git ls-files` has left the project. So the index is compared every two seconds — one `lstat` to see whether git wrote it at all, and a `git ls-files` only when it did — and what has gone is removed from the server, after its copy is kept. A linked worktree's own index is read, not the repository's shared one.

Outside a repository there is no index to consult, so a folder that is not a checkout falls back to watching for deletions and still needs `watcher.autoDelete`, as it always did.

**Nothing is dropped.** A file that fails to upload goes back in the queue behind a cooldown that grows with each further failure, up to five minutes, so a server that is briefly refusing is waited out rather than hammered. `sftp.autosync.retrySeconds` sets the first wait. What is still waiting when the window closes is written down and picked up when it opens again, and you are told it is being resumed. Stopping autosync drops the queue and says how many files were in it, because nothing would drain it afterwards.

**The server's copy is kept before it is written over.** Once per file per session — the point is the state before this run started, not before each save — which costs one extra fetch per file the session touches. If the server cannot be reached to make that copy the file is **not** overwritten; it goes back in the queue instead, because that is exactly the case where an overwrite would destroy the only copy of what was there. A file that was not on the server is recorded as having been absent, which is also a state to put back. Turn the whole thing off with `sftp.autosync.backupRemote`; sessions are swept after `sftp.autosync.backupDays` (30), whole sessions at a time so that one you can still see is one that can be restored in full. A file larger than `sftp.autosync.backupMaxMB` (20) is uploaded without a copy being kept — the copy passes through memory on its way to disk, and a database dump would take the window with it — and the log says so, naming the file, because that one has no way back.

### Reveal Autosynced Folder in Finder / in Terminal
On a connection in the Remote Explorer or a folder in the file explorer, directly under the autosync entries, and **only while a connection is syncing a folder this window does not have open**. On its own folder they would be two more ways to open the folder already open.

That case is the one worth a command: the file explorer shows this window's project and the Remote Explorer shows the server, so nothing on screen leads to the checkout actually being deployed — the branch name in the picker is the only trace of it, and a branch name is not a path. Finder, File Explorer or the system's file manager by platform; the terminal is the machine's own, not the built-in one, honouring `terminal.external.*Exec`.

A worktree removed by hand leaves the rest of git in place, so the folder may simply be gone; both say so rather than opening nothing.

### Move All Passwords…
From the palette, always — it is a question about where passwords should live, not a one-way migration that stops being offered once it has run.

It asks first **which configs to look at** — the ones this window has open, or every `sftp.json` under a folder you pick, three levels deep. A window usually has one project open and the passwords are spread across all of them, so “this window” alone would not be the question anybody is asking.

Then it finds every password and key passphrase in those, wherever each one is now: written in plain text, or marked `true` and held in a store. It says what it found and where, and asks where they should all be instead: It says what it found and where, and asks where they should all be instead:

| Destination | What happens |
| --- | --- |
| **macOS Keychain** | Written to your login keychain (not synced to iCloud) and taken out of wherever they were |
| **VS Code secret storage** | The editor's own store, on any platform |
| **The config files** | Written back into `sftp.json` as plain text, and deleted from the store that held them |

So it moves file → store, store → store, and store → file. That last one is the direction nobody builds and everybody eventually wants, usually at the moment they are trying to leave.

`sftp.passwordManager` is set to match, and any `passwordManager` written into an individual connection is removed — otherwise that one connection alone would still look in the old place, and nothing on screen would say why.

**The order never changes, whichever way it is going.** Every secret is written to its new home and *read back* before it is taken out of the old one. A store that refuses, a keychain that is locked, a value that comes back different — that secret stays where it was. A delete that runs before the write is confirmed is how a password stops existing.

Profiles are handled: a profile that names only a password still belongs to its parent's host and user, which is what the store entry is keyed on.

**What it will not move.** A credential is keyed by `protocol://user@host:port/<project>` — one record per connection. Two connections of the *same name* on one account would still share a key. Where they share a password too that is fine — one entry serves them all. Where two of them hold *different* passwords, neither is moved: the store cannot hold both, and moving one would silently give its password to the others. Those are named so you can look at why they differ. A password held in something only readable, such as 1Password, is read from but never deleted.

### Change a Server’s Password…
From the palette. Lists the servers your connections use — `dr@univers.metanet.ch:2121`, with the projects that reach it — asks for the new password once, and writes it to every connection on that server, wherever each copy lives.

This is the other half of keeping **a record per project**. That shape is right: it is how these are thought about, it lets two connections on one account hold different passwords, and it makes each entry findable by the project's name. What it costs is that six sites on one hosting account hold six copies of one password — and a rotation that updates one of them leaves five connections that start failing at a time nobody is watching.

A copy written in a config file is rewritten there; a stored one is written to its store and read back. Nothing is deleted and nothing moves — only the value changes — so a connection keeps whatever arrangement it had.

It is **not** tried against the server first. If the new password is wrong, the first connection says so and asks, and a rejected stored password is forgotten rather than kept, so the mistake costs a prompt rather than a repair.

### Remove Files Deleted from the Repository
On a connection in the Remote Explorer, or from the palette — and only on one whose local folder is a working copy, since a folder with no history has nothing to ask. Asks git what the repository has deleted over its history, keeps the paths that really are gone from the checkout, and offers to take those off the server — with the list and the count before anything moves, and a copy of each kept first, so `Restore Server to an Earlier Point` still works afterwards.

A server accumulates. Downloads write and never remove; a deploy uploads what exists rather than removing what stopped existing; autosync takes files off as they leave git's index, but only from the moment it starts watching. Everything dropped before that is still there.

**This and `Sync Local -> Remote` answer different questions, and confusing them is expensive.**

| | asks | removes | risk |
| --- | --- | --- | --- |
| `Remove Files Deleted from the Repository` | git's history | only paths the repository once tracked | cannot name a file the project never owned |
| `Sync Local -> Remote` with `syncOption.delete` | the server's listing | anything not on this machine | includes runtime directories, uploads and caches the repository ignores |

The second is the complete answer and the dangerous one. On a project whose `.gitignore` holds `/data/*` — runtime content that lives only on the server — and whose `sftp.json` has no `ignore` list, it would delete that content. The first cannot, by construction: a path git never tracked can never appear in the list.

Renames count as a deletion of the old path, which is what they are from a server's point of view — the old name is still sitting there. A file deleted in one commit and written again in another is not offered; the history says both things and only the disk settles it. Offered again after an `Everything in the folder` catch-up, since uploading everything the project *has* says nothing about what it used to have.

### Restore Server to an Earlier Point
On a connection in the Remote Explorer, or from the palette. Lists the autosync sessions that kept anything, newest first, with how many files each holds and how long ago it was. Picking one puts back, for every file that session or a later one wrote over, the **earliest** copy from that moment on — which by construction is what the file was before the first thing in that window touched it.

Files that were not on the server at the chosen moment are removed, since that is what putting them back means. The count of those is stated separately in the confirmation, because it is the one destructive part. Uploads go through the connection's own transfer machinery, so `concurrency`, `verifyTransfer` and `useTempFile` apply as they do everywhere else.

Picking a folder usually happens after the work has started — an agent has been writing for twenty minutes before anybody looks — so you are offered a catch-up, and asked what it should cover. Where there is a branch, git answers exactly and for nothing: the files that checkout has and the deployed branch does not, plus whatever is not committed there yet. Where there is not — a plain project folder, or a checkout sitting on a commit rather than a branch — the only thing left to ask is the disk, so the offer is by time instead: changed in the last hour, the last 24 hours, the last 7 days, or everything in the folder. The count is shown before anything moves, and the upload can be cancelled while it runs.

The catch-up uploads through the connection's own transfer machinery rather than a path of its own, so `concurrency`, `verifyTransfer`, `useTempFile` and the per-file retries are the same ones every other upload gets. Anything that still fails joins the retry queue.

The comparison is against the branch this window's own worktree is on, because that is what has been going to this server until now. It is a guess at what is actually there — the exact answer needs the server, which is what `SFTP: Sync Local -> Remote` does — so the branch it compared against is named in the question.

Files deleted on that branch are listed but not removed unless `watcher.autoDelete` is on, and it says so.

A file must sit still for three seconds before it is uploaded — a build step writes a hundred files in a second, and a tool that writes without an atomic rename leaves a half-written one visible in between. `sftp.autosync.settleSeconds` changes that. Deletions in a checkout follow git's index, as described above; in a plain folder they follow `watcher.autoDelete`. The connection's own `ignore` rules apply, evaluated against the checkout's root, and `.git` is never uploaded.

A plain folder has nothing to catch up against — git can say what a branch changed and knows nothing about an ordinary directory — so it is watched from the moment you choose it.

When a worktree appears that was not there before, you are asked once whether to deploy it instead. Never adopted on its own.

### Clear Local Folder
Sits under `Download Scripts` in the Remote Explorer's menu, on folders and on a connection's root — nowhere else, and only where something has been downloaded — and not on anything whose local copy sits in a repository. Clearing a folder is for a download that has to start from nothing, and nothing in a working copy is that: the files are tracked, the history is beside them, and what the command would delete is not what a download would put back. The search for one walks up from the folder and stops at the workspace — a repository above the folder the editor has open is not this extension's business. Deletes the contents of the *local* copy of that folder and never touches the server.

`Download Scripts` writes files and never removes them, so a folder downloaded across a year of deploys holds files the server deleted months ago — and nothing downstream can tell those apart from current ones. This is the other half of it: clear the folder, download it again, and what is on disk is what is on the server.

You are asked first, with the number of files and how much they come to, and told when the folder is the whole local copy of the connection rather than a part of it. What goes is moved to the system's trash where that is possible, and deleted outright only where it is not.

Two things are never removed: anything the connection's own `ignore` rules cover, and `.git`, `.svn`, `.hg` and `.vscode` at any depth. A repository is not an old copy of the deployed files — it is the history of them, it is not on the server, and no download would put it back. A folder holding something kept back is emptied around it rather than removed.

The folder you asked about goes with its contents — that is what clearing it means. Two exceptions, and both are the folder being unable to go rather than a preference: the connection's own root stays, because the editor has it open and taking it away leaves a window pointed at nothing; and a folder holding something kept back stays to hold it.

### Before a download replaces your file
Downloading a single file — with `Download File`, from the Remote Explorer, or through `downloadOnOpen` — first compares what is on disk against what is on the server.

If the local copy is **newer**, you are asked before it is replaced, with the two timestamps. If it is older, or missing, or identical, the download proceeds as it always did; the question only comes up when downloading would throw away work that exists nowhere else.

The question offers four ways on besides cancelling:

| | |
| --- | --- |
| `Overwrite` | Download, replacing the local file. |
| `Compare` | Show the two side by side. |
| `Open Local` | Open the file on disk. |
| `Open Remote` | Download the server's copy into a folder of its own under the system's temp directory and open it there. It can be edited like any file, and the local one is not touched. Each save of it asks whether to upload it back to where it came from. |

While the connection is [autosynced from another folder](#autosync-worktree), the question comes up for **any difference in content**, whichever copy is newer. The server then holds that folder's work rather than an older version of yours, and the timestamps of two folders say nothing about which is right — so the bytes are compared instead, and identical files download without asking.

Timestamps are compared to the second, matching the sync algorithm, and a transfer copies the source's timestamp onto the target — so a file you downloaded and did not touch reads as identical, not as a conflict. A file changed within the same second is still treated as a conflict when its size differs.

`sftp.downloadWhenLocalIsNewer` controls this:

| Value | |
| --- | --- |
| *ask* | Ask first. The default. |
| *download* | Download without checking, how it behaved before. Still asks while another folder is autosynced. |
| *skip* | Keep the local file and note it in the SFTP output channel. |

`Download` in the [Alt menu](#alt-commands) always downloads, whatever this is set to.

### SFTP: Cancel All Transfers
Stop the current transfers (upload and download).

### SFTP: Open SSH in Terminal
Open a terminal in VSCode and auto login to a specific server.


## MCP server

Lets a local AI client — Claude Desktop and most others — read the files on the
servers configured here, so you can ask about deployed code without mirroring a
tree by hand.

Off by default. Turn it on with the `sftp.mcp.enabled` setting, then run
**SFTP: Show MCP Connection Details** from the command palette and paste the
snippet into your client. It carries no token and no port, so it never needs
updating:

```json
{
  "mcpServers": {
    "sftp": { "command": "node", "args": ["~/.vscode-sftp/mcp-bridge.js"] }
  }
}
```

### What a client can see

Exactly the connections open in your editor — the same ones in the SFTP
explorer. Nothing is remembered between sessions, and a project that is not open
cannot be reached.

Hide one with `mcp.exposed`, which works inside a `profiles` block too, so
switching to a production profile can remove the server from the client's list
rather than quietly re-pointing the same name at a different machine:

```json
{
  "host": "example.com",
  "mcp": { "exposed": false }
}
```

`sftp.mcp.exposed` is the default for connections that do not say.

Every tool takes an id from `servers`, or the name beside it where no other connection answers to that name. An id is derived from where the connection points — the project, the host, the account, the path and the name — so it means the same thing after a reload, and one from an earlier session is still good. It is not the editor's own connection number, which lands on a different server every time a window reloads.

### Tools

| Tool | |
| --- | --- |
| *servers* | The servers available, and what each one is |
| *list* | One directory, as it is now |
| *stat* | Whether a path exists, and how a local copy compares |
| *read* | A file's contents — always the server's version |
| *local-copy* | Your working copy, when it differs |
| *search* | Text and path search across the server's files |
| *tree* | The shape of the server, annotated with what each file is for — or, with `since`, what changed |
| *history* | Earlier versions of a file: the editor’s local history, and copies a download replaced |
| *diff* | A unified diff between any two of server, working copy, earlier version, another connection |
| *note* | Record what a file — or the project — is for, so it shows up next time |
| *forget* | Drop descriptions |
| *overview* | What the project appears to be, from its own files and from what somebody recorded |

### Descriptions
`note` records what something is for, on this machine and never on the server. With a path it describes that file and appears beside it in `tree`; without one it describes the whole project, and appears in `overview` and on that connection's line in `servers` — which is where to put what a server is actually *for*, since `overview` can otherwise only repeat what `composer.json` says about itself, and says nothing at all about a project without one.

A description is a short line and, optionally, the synthesis behind it. The line is capped at 200 characters because it shares a line with a path in a listing of eight hundred; the synthesis has two thousand and is read with the file. The split is there because a description that has to fit one line oscillates: whoever reads a file reads it for something and writes the line they needed, and the next reader is there for something else. The synthesis is where the understanding accumulates instead — read what is there, fold in what you have just learned, write the whole thing back. The one it replaced is kept, in case a rewrite dropped something.

A description is anchored to what the file's bytes hash to, not to its timestamp. Every deploy here is an upload and an upload restamps every file it copies, so against a timestamp a redeploy of unchanged code would mark every description on a server stale at once. Against the content, a file whose bytes are the same keeps its description however often it is uploaded — and one whose bytes differ has moved on however the timestamp reads, including a change that keeps the size.

None of that happens unless descriptions get written, so `read` asks: for one when a substantial file has none, for a correction when the one it has describes an older version, and for a better line when reading has turned up something it does not say. Once each per file per window.

### What changed

`tree` with `since: "7d"` (or `"48h"`, or a date) lists only the files
modified in that window, newest first, with the time on each line. When something
worked until recently, what the last deploy touched is usually the whole answer
rather than a hint towards it — and it costs the same one walk as any other tree,
with the same paging.

### Three versions of every file

A file you are working on exists in three forms: the one on the server, the one
on your disk, and the ones you saved earlier. The first two are what `read`
and `local-copy` return. The third comes from VS Code's own local history,
which `history` reads — it is the only record of how your working copy got
to where it is.

`diff` compares any two of them: the server against your copy (the default),
an earlier version against what you have now, or an earlier version against the
server. It answers “what changed” without an agent reading both files in full.

A side can also be another connection, written `server:<id>` — so “what differs
between staging and production” is one call. The file is matched by its path
*below* each connection's root, since two servers hosting the same project mount
it in different places, and the other connection has to be exposed and to contain
the counterpart or the comparison is refused.

Local history is read, never written. It only covers files saved in this editor
on this machine, it is capped by VS Code's own
`workbench.localHistory.maxFileEntries`, and turning that feature off — or
setting `sftp.mcp.exposeHistory` to false — removes it here too.

### When a download replaces your work

VS Code's local history records what VS Code writes. A download is written by
this extension, so the editor never sees it and the Timeline has nothing to go
back to — which matters most for files the editor never saved in the first
place.

So before a download writes over a local file that differs from what is
arriving, the old contents are kept. Nothing is kept when the file matches the
server's copy already, which is most of a folder download, and nothing is kept
on upload.

Run **SFTP: Restore File Replaced by a Download** to get one back: it lists the
copies of the current file by date, and offers a diff before you commit to one.
Restoring keeps the file it replaces too, so picking the wrong version is not
the end of the story. The same copies show up in `history` beside the
editor's own versions, in one list ordered by time.

| Setting | |
| --- | --- |
| *sftp.keepReplacedFiles* | Off switch. On by default |
| *sftp.keepReplacedFilesPerFile* | How many copies of one file to keep. Five |
| *sftp.keepReplacedFilesDays* | How long to keep them. Thirty days |

| ⚠️ Warning |
| :--- |
| *This protects the copy on your disk, not the one on the server. An upload that overwrites a remote file is still irreversible.* |

| ⚠️ Warning |
| :--- |
| *Credentials are replaced on both sides before a diff is computed, so a credential that **changed** shows as no change at all. The diff says so when this applies.* |

### Where files go

Reading a file the project does not have puts it in the project, so it becomes a
working copy you can keep. Reading one that **differs** from your local copy —
in either direction — puts the server's version in a separate cache and leaves
yours alone.

The server never changes a file you already have. What it returns is always the
server's version; `local-copy` is the only way to the other one, and it
says so when they differ.

`mcp: { "materialize": false }` keeps it out of the project folder entirely.

### Testing it end to end

`npm test` runs the unit suites, which stop at the network: every one of them
hands the code a fake server. `npm run e2e` runs the rest — a real SFTP server
started inside the test process, a real socket, the real ssh2 client, the real
MCP server, and a JSON-RPC client driving the tools the way a real one does.

Because the server is ours, it can misbehave on demand: a command that never
answers, and a transfer that goes quiet halfway through a file. Those two cases
are the reason the suite exists — they cannot be triggered by hand, and they are
where an agent otherwise waits forever.

| ⚠️ Note |
| :--- |
| *ssh2 1.13 calls `util.isDate`, which Node removed in version 23. VS Code bundles an older Node, so the extension is unaffected; the e2e suite shims it for its own process only.* |

### What it will not reach

Every path is resolved against the connection's `remotePath` and refused if it
lands outside it, so `../..` cannot walk into another site on the same server or
write a file outside your project folder. Files over 2 MB are refused before
they are fetched and skipped during a search — raise `sftp.mcp.maxFileBytes` if
you work with larger source files. Binary files are reported as such rather than
returned as text, and a listing of more than a thousand entries says how many it
left out.

Cached copies of files the server no longer has are removed whenever `tree`
walks a complete tree, alongside the descriptions for those files.

Nothing is a dead end. A listing shows a thousand entries at a time, a tree a
thousand files, and a search stops at its match limit or its time budget — each
of them says where it stopped, and `offset` carries on from there. Continuing a
tree or a search does not walk the server again: the file list is kept for two
minutes so page two costs almost nothing.

No call waits forever: every server operation has to answer within
`operationTimeout` (60 seconds by default), and a transfer that goes silent for
that long is abandoned and retried rather than left hanging. A whole tool call
is capped by `sftp.mcp.callTimeout` (two minutes) on top of that — a search or a
tree walk that reaches it returns what it found so far and says it was cut
short, rather than failing or running on.
### Before a password goes out in the clear

Plain FTP sends `USER` and `PASS` as readable text — but a great many hosts
accept FTPS without anyone configuring it. So a connection configured as plain
FTP is *attempted* over TLS, and kept that way for as long as it keeps working.

Nothing is predicted, because asking a server what it supports is a weaker
question than it appears. FTP runs commands over one connection and listings and
file contents over another, and encryption can succeed on the first while
failing on the second — a firewall that watched the control channel for `PASV`
is blinded once it is encrypted, and some servers want the data connection to
resume the control session. A server will advertise `AUTH TLS` in either case.

So the upgrade is abandoned for that server the moment anything goes wrong with
it: at the handshake, at a listing, or three files into a download. The
connection is remade as configured, the log says what happened, and TLS is not
tried again on that server for a day. Failures that are about the request rather
than the transport — a missing file, a permission — are not treated as evidence.
A *hang* is: a data connection that never completes its handshake is the same
signal as one that fails.

An upgraded connection does **not** verify the certificate: it protects the
password from anyone watching the network, not from whoever answers.
`"secure": true` in `sftp.json` is what buys verification, and an upgrade never
overrides what you configured. Turn the whole thing off with
`sftp.upgradePlainFtp`.

When the server genuinely cannot do TLS, the extension says so and waits — once
per server, with the option to allow it for good on that server.
Turn the question off with `sftp.warnOnCleartextPassword`.

### Credentials are withheld

`.env` files, `wp-config.php`, `.htpasswd`, private keys and similar are never
served: the reply says the file exists and that its contents are withheld. Add
your own names with `sftp.mcp.deniedFiles`.

Recognisable credentials elsewhere — AWS keys, GitHub and Slack tokens, Stripe
keys, private key blocks, JWTs — are replaced before anything is returned or
searched, and the reply says how many. So are credentials written out next to a
name, such as `define('DB_PASSWORD', '…')`, `$cfg['pw'] = '…'`, `PASSWORD=…` in a
Dockerfile or `password: …` in YAML — in German and a dozen other languages as
well as English — along with connection strings that carry their own password
(`mysql://root:…@host`) and `Bearer` tokens. References like `env('DB_PASSWORD')`,
`process.env.API_KEY` and validation rules are left alone, as are CSS selectors
such as `input[type="password"]:focus`. Set `sftp.mcp.redactAssignments` to
`false` if that layer takes out code you need.

Each replacement is a numbered marker — `[redacted:assigned-secret:2]` — standing
for one value, and the reply tells the model the real values are unchanged and
that the markers are to be left alone. **Only what is sent to the client is
redacted.** The file in your project folder is the server's, byte for byte, so
editing and uploading it by hand can never replace a credential with a marker.

A file that had something replaced cannot be fetched whole, only in ranges,
because a client saving it back would overwrite the live value with the marker.

| ⚠️ Warning |
| :--- |
| *No list catches every secret. A password in somebody's bespoke config file will be served like any other code. Redaction reduces the damage; deciding which servers to expose is what prevents it.* | 

### Building up what you know

`tree` shows the structure with a line about each file, where one has been
recorded. An agent that has just worked out what a file does can save that with
`note`, and the next session — yours or anyone's — starts with it. Nothing
is written to the server; the notes live on this machine.

A note describes one version of a file. When the file changes the note is shown
as stale rather than quietly describing something that is no longer there, and
notes for files the server no longer has are cleared out as the tree is walked.

`overview` reports what the project appears to be — framework, name,
description — read from `composer.json`, `package.json` and a theme header.
Facts only: nothing there is guessed.

### Cost

These are remote servers. A listing is a round trip, and a search fetches every
file it looks at before it can search it — so scope searches with `dir`. The
first search over a folder downloads it; later ones re-fetch only what changed.
`sftp.mcp.excludeFolders` keeps `node_modules` and friends out of the way, and
`sftp.mcp.maxFiles` and `sftp.mcp.maxDepth` bound the walk.

### Several windows

The first window to take the port serves, and the others register their own
connections with it, so a client sees every project you have open as one list.
If the leading window closes, another takes the port and the rest re-register
with it.

### What it will not do

- Write to your servers. It is read-only; it does write to your disk.
- Prompt you. A connection with no stored password fails with a message saying
  to connect once in VS Code, rather than opening a dialog behind whatever
  application you are actually looking at.
- Reach anything not open in the editor.

## Host keys

Every connection is checked against the key the server presents, before a password reaches the wire. Until this existed the extension checked nothing: whatever answered on port 22 got the password out of `sftp.json`. That was survivable when connections happened because somebody pressed save; autosync opens them on its own, repeatedly, on whatever network the machine woke up on.

Trust is read from OpenSSH's own `known_hosts` first, so a host you have already accepted in a terminal is never asked about again, and then from this extension's own store. The two are kept apart deliberately — adding lines to somebody's `~/.ssh/known_hosts` is not a thing to do uninvited.

Three outcomes, and they are not the same question:

- **A host with nothing on record** shows its fingerprint and asks once. Answering no refuses the connection; nothing has been sent at that point.
- **A key that has changed** is refused and says so, with the old and new fingerprints side by side and `Update the stored key` as the way through — because the innocent explanation is common (a server rebuilt, keys rotated) and the other one is not (something answering in the server's place, which would be handed that connection's password).
- **A key marked `@revoked`** is refused outright. That decision was already taken by whoever wrote the line; there is nothing to ask.

One question per host however many connections are waiting on it — 156 connections here share 26 hosts, and several open at once.

`StrictHostKeyChecking` and `UserKnownHostsFile` in your ssh config are honoured, which they were not before: the extension read that file but mapped only six directives and went straight past these two. `no` and `off` turn checking off for that host; `accept-new` takes a new host without asking and still refuses a changed one. Per connection, `"hostVerification": false` in `sftp.json` does the same, and `sftp.hostVerification` turns it off everywhere.

## Alt commands
An alternative command can be found when pressing `Alt` while opening a menu.

### Force Download
Download file but disregard ignore rules.

### Force Upload
Upload file but disregard ignore rules.
