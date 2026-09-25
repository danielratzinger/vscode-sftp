# Changelog

This fork continues the changelog below, which is the history of the
extension as written by [liximomo](https://github.com/liximomo/vscode-sftp)
and maintained by [Natizyskunk](https://github.com/Natizyskunk/vscode-sftp).
Everything from 2.0.0 onwards is this fork; everything under 1.16.3 and
earlier is theirs.

## 2.4.0 - 2026-09-25

### Added

- **A folder now travels as one archive instead of one file at a time.** A
  folder of small files is slow because of the round trips, not the bytes: SFTP
  opens, reads and closes each one, so five thousand files over a link with 30ms
  of latency is minutes of waiting for permission to send the next thing. Where
  the server can run a command - SFTP with `tar` and `gzip` - a download now
  asks it to pack the folder and reads one stream, and an upload streams one in.
  The recursive listing goes away with it on the download side, because the
  recursion is the server's to do. Switched off per connection with
  `useArchiveTransfer: false`.
- An upload unpacks into a staging folder inside the target and then moves each
  file into place. Within one file system that is a rename, so a file is the old
  one or the new one and never half of either - which is what `useTempFile` has
  always been for, and what unpacking straight into the target could not give: a
  half-written PHP file at the path a web server is reading. The staging folder
  is cleared however the script ends, at once on a dropped connection, and a day
  later by the next upload's sweep if this editor dies in between.
- It is meant to be indistinguishable from the slow way, and that is where most
  of the work went. The same `ignore` and `Download Scripts` filters are applied
  as the archive is read, in the same places - folders are not asked what a
  file-level filter thinks. Both timestamps come from the archive's extended
  headers. A downloaded file is written in place, so the inode survives and a
  hard link holds. A file already on the server keeps its own permissions, a new
  one gets the ones it came with, and `filePerm` and `dirPerm` still decide when
  they are set. Symlinks stay symlinks. Nothing outside the folder is touched,
  and nothing is ever deleted.
- Every way it can fail ends in the ordinary transfer, with the reason in the
  output panel: a server set up for file transfer only, no `tar`, a `tar` nobody
  recognises, a bad exit, a broken stream. A folder that half arrived is simply
  written again. An upload only takes the archive route past 50 files, since the
  walk that counts them is on this machine and costs nothing; a folder download
  always asks, because counting first would mean the listing it exists to avoid.

### Fixed

- **A file in a transferred folder was created with the mode of the folder the
  transfer started at.** Uploading one PHP file gave it 0644; uploading the
  folder around it gave the same file 0755. The walk passed the mode to fall
  back on straight down without refreshing it per file, which only showed on a
  file that was not on the server yet.
- **A mode Windows invented is no longer sent anywhere.** Windows has none to
  report, so Node makes one up - 0666 for a file anyone may write, 0444 for a
  read-only one - and 0666 on a server is a world-writable file, which some
  hosting refuses to run at all. A file uploaded from Windows is 0644 now and a
  folder 0755. `filePerm` and `dirPerm` still override both.
- An entry a machine will not write is one file's failure rather than the whole
  transfer's, which is what it is file by file: a name Windows has no way to
  spell, a symlink it will not allow. Unless nothing landed at all, which says
  the trouble is with every entry and not with one of them.

## 2.3.6 - 2026-09-25

### Fixed

- **A file the server rewrote while it was being read came back as a failed
  transfer.** The size to expect is read when the transfer is planned, which for
  a folder is one listing covering every file in it, so a file the server
  rewrites in between arrives at a size nobody promised. The check called that
  incomplete - even when *more* bytes had arrived than were expected, which is
  not a shape a truncated transfer has - and the retry compared against the same
  stale number on every attempt, so it could only fail the same way three times
  over. The source is now asked what it holds before any of this is called a
  failure: a size that moved on refreshes the expectation, timestamps included,
  and the file is read again, because one that grew mid-read can arrive stitched
  together. A file that never stops changing keeps the copy matching what the
  last look found, rather than taking the whole folder's transfer down with it.
  A real mismatch still fails, and now says which way it went - short, or longer
  than its source.

## 2.3.5 - 2026-09-24

### Changed

- `Remove Files Deleted from the Project` is now `Remove Files Deleted from the
  Repository`, which is what it actually asks. Its whole answer comes from
  `git log`, so it can only ever name a path the repository once tracked - the
  old name suggested it knew what the project contained, and it does not.
- It is offered only where there is a repository to ask: on a connection whose
  local folder is a working copy in the Remote Explorer, and in the palette only
  when some connection in the window has one. Before, it appeared everywhere and
  answered a folder with no history by saying so - which is a dialog where the
  entry should not have been. The menu asks the item itself, through the `-repo`
  it already carries; the palette cannot be on an item, so it asks the same
  question of the window.

## 2.3.4 - 2026-09-24

### Fixed

- **Every connection on one login opened a socket of its own, and none of them
  were ever closed.** Two entries in `sftp.json` that reach the same server over
  the same credentials are one connection and share one socket - which is why
  the name and the `remotePath` are stripped before a connection is looked up.
  The connection's name got past that, because it rides on the same object: a
  credential is keyed per project, so the resolver has to know which project
  this is. It is not part of reaching the server, and treating it as part of the
  identity meant six sites on one hosting account held six sockets, each sending
  its own keepalive every thirty seconds. The disposal path computed the identity
  *without* the name, so its key never matched and nothing was found to be
  ended: saving `sftp.json` left the old connection running, heartbeat and all,
  and opened another beside it.

  Worth saying about the debug log, since this is where it shows: a ping
  answered with `REQUEST_FAILURE` is a healthy heartbeat. OpenSSH does not
  implement `keepalive@openssh.com` as a real request and refuses it on purpose;
  any answer at all is the proof of life, and only three unanswered pings in a
  row end the connection.

## 2.3.3 - 2026-09-24

### Fixed

- **Renaming a connection lost its password.** A credential is keyed by the
  account *and* the connection's name, which is what gives six sites on one
  hosting account six records - and it means a rename looks under a key nothing
  was ever stored under. The exact key still comes first and always; when
  nothing is there, the records for the same `user@host` are what is left to go
  on, and a server has one password per login, so one of them is it. Where
  several could answer, the most recently written one is taken: the Keychain
  keeps modification dates as plain attributes, so they can be read without
  unlocking anything, and VS Code's secret storage - which cannot be enumerated
  at all - is stood in for by a list of written keys held newest first. Nothing
  is moved and nothing is deleted: the password is borrowed, a record under this
  connection's own name appears once the server has accepted it, and if the
  server turns it down the borrowed record is left alone and you are asked.
  The same applies to a connection added *beside* another on one login, and to
  records still keyed by account alone from before 2.3.0.
- `Move All Passwords…` and `Change a Server's Password…` now say what they
  wrote. They write straight into a store, and for VS Code's secret storage that
  list is the only record that anything is in there at all - so a password moved
  in by the sweep was invisible to the above, and a renamed connection asked
  again with its password sitting right where it had been put.
- **Renaming a connection and giving a new one its old name stopped the Remote
  Explorer rendering anything from that point down.** The roots were built into
  the live cache one at a time, so a connection that could not be read left a
  half-filled cache that was then returned for ever. They are now built aside
  and published in one go, an unreadable connection is skipped with a line in
  the output panel rather than abandoning the rest, and a node from a tree that
  has since been rebuilt returns no children instead of throwing.
- **Changing `remotePath` while connected left that connection's folder
  spinning and answering nothing.** Saving `sftp.json` ends every file system
  for the workspace, and ending one left it still claiming to be valid, with a
  pending connect that would never settle - handed to every later caller. It now
  clears both, and a connect that lands after its connection was ended no longer
  reports success on a dead socket: each life of a connection is numbered, so a
  late answer can tell it belongs to a previous one.

## 2.3.2 - 2026-09-24

### Fixed

- `Can't find config for remote resource remote://…` appeared from time to time
  while autosync was running. Each root in the Remote Explorer carries the id
  of the connection it was built from, and a refresh rebuilds them all - so a
  folder the editor still had expanded could arrive holding an id from a
  generation that was gone. Autosync fired that refresh twice for every batch
  it sent, which turned a rare race into a regular interruption. The refresh
  was there for a mark that changed colour while uploading, which is not what
  the mark does any more, so the event now fires only when autosync starts,
  stops or resumes. A node from a tree that has since been rebuilt is no longer
  an error either: it has no children, which is worth saying quietly rather
  than in a dialog.

## 2.3.1 - 2026-09-23

### Changed

- While a connection is autosynced from another folder, a save in this window
  with `uploadOnSave` on asks whether to upload it instead of quietly not
  sending it. The question is a notification, one per file at a time, so
  auto-save does not stack them.
- A copy opened with `Open Remote` asks on each save whether to upload it back
  to where it came from; before, its saves stayed in the temp folder.

### Fixed

- `Open Remote` from the remote explorer was followed by the local file being
  opened on top of it, hiding the copy that was asked for.

## 2.3.0 - 2026-09-23

### Added

- The warning before a download writes over a newer local file now offers
  `Open Local` and `Open Remote` beside `Overwrite` and `Compare`. `Open
  Remote` downloads the server's copy into a folder of its own under the
  system's temp directory, where it can be edited and saved like any file
  without touching the local one. While the connection is autosynced from
  another folder, the same question comes up for any difference in content,
  whichever copy is newer: the server then holds that folder's work, and the
  timestamps of two folders say nothing about which is right.

### Fixed

- On macOS and Windows, removing a deleted file from the server failed before
  it started: working out where the file lived asked the file system for its
  real path, and a deleted file has none. Autosync retried it every few
  minutes for ever, a stack trace each time, and remembered it across
  restarts. The casing now comes from the nearest folder that still exists.
- A removal whose file was already gone from the server failed for ever too;
  that is now what was wanted, and done. One that cannot be placed on the
  server is said once and dropped. Any other failure is still retried, but
  only the first one is logged in full.

## 2.2.1 - 2026-09-21

### Fixed

- A file deleted while autosync was sending it was treated as a failure, so it
  went back in the queue and failed the same way for ever - a red line a
  minute for each one. An integration test that writes fixtures and deletes
  them again produced a steady stream of them. Whether something is worth
  trying again is a question about the file rather than about the error: one
  that no longer exists is dropped, and the transfer that found it gone says
  so quietly instead of reporting a failure. The gap between deciding to send
  a file and reading it cannot be closed - the scheduler runs the transfer
  later, by design - only understood.

## 2.2.0 - 2026-09-21

Where credentials live, and a set of fixes found by running the previous
release rather than by reading it.

### Added

- `SFTP: Move All Passwords…` answers one question - where should passwords
  live - and moves them there from wherever they are now. Into the macOS
  Keychain, into VS Code's secret storage, or back into the config files,
  which is the direction nobody builds and everybody eventually wants. It asks
  which configs to look at: the connections this window has open, or every
  `sftp.json` under a folder you pick, since a window usually holds one
  project while the passwords are spread across all of them. Each secret is
  written to its new home and *read back* before it leaves the old one; a
  locked keychain or a value that returns different leaves that secret exactly
  where it was.
- `SFTP: Change a Server's Password…` writes one new password to every
  connection on that server at once. The cost of keeping a record per project
  is that six sites on one hosting account hold six copies; a rotation that
  updates one of them leaves five that start failing at a time nobody is
  watching.
- `passwordWriteCommand`, the other half of `passwordCommand`: a shell command
  that *saves* a password, reading it on standard input. Without it a manager
  reached by command was read-only, so a password typed at a prompt was used
  once and lost. Written to, then read back and compared - `pass insert`
  reports success on writing to the wrong path as readily as the right one.
- Credentials are now kept **per project** rather than per account. The key
  carries the connection's name, so six sites on one hosting account have six
  records, each labelled `dr@univers.metanet.ch (sportswise.com)` and findable
  by the project name. Two connections on one account can hold different
  passwords, which before was not representable at all.

### Fixed

- **Every SFTP connection failed with `Bad packet length`.** Host key checking,
  added in 2.1.0, answered asynchronously - and ssh2 advertises `ext-info-c`,
  so an OpenSSH server sends `EXT_INFO` in the same breath as `NEWKEYS`,
  encrypted under the new keys. A verifier that has not answered by then
  leaves ssh2 holding the old decipher. The decision is now made synchronously
  against what was read before the socket opened; a host that needs asking is
  refused, asked about, and reconnected. The e2e suite could not catch it
  because ssh2's own server does not send `EXT_INFO`, so the invariant is now
  checked directly: the verifier must return a boolean, never a promise.
- **Autosync queued directories.** A watcher reports a folder whenever
  anything inside it changes, and `transfer()` sends a directory to
  `transferFolder` - so a change anywhere would have re-uploaded the whole
  checkout. Only the backup probe failing on a directory prevented it, which
  is also why two paths retried in a loop for ever. Only regular files are
  sent now, and a remote directory is no longer mistaken for a server that
  cannot be reached.
- **Palette commands failed silently.** `doCommandRun` called its handler
  without returning the promise, so the `try/catch` in `Command.run` could
  never catch anything: no dialog, no log line, nothing to distinguish "it
  went wrong" from "it did nothing".
- **`sftp.printDebugLog` needed a window reload to take effect**, because the
  flag was read once at import - which is exactly backwards for a switch
  nobody touches until something is already wrong. It is read per line now.
  `sftp.debug` is the name to use; `printDebugLog` is marked deprecated, which
  it has been since upstream added the shorter name without saying so.
- Autosync did not mark anything after a window reload. The decorations are
  registered during activation and the connections are built after it, so
  everything showing what was syncing asked before there was an answer and had
  no reason to ask again.
- The file explorer's autosync menu asked whether *something* in the window
  was syncing, which put `Stop` on every project or on none. It asks about the
  folder itself now, through `resourcePath in sftp.autosyncPaths`.

### Changed

- A connection being autosynced is marked in one colour - the blue of a
  notification's information icon - whether the folder it deploys is this
  window's own or a checkout somewhere else; the badge says which. The colour
  answers one question, which is whether `Stop Autosync` would do anything.
- Keychain items read `dr@univers.metanet.ch (sportswise.com)` in the Name
  column, rather than the Account column repeated behind a prefix.

## 2.1.0 - 2026-09-21

Continuous deploy, built out until it does what a shell script I had been
using for it does - and then past it, because two of the things it needed
turned out to be missing from the extension as a whole rather than from
autosync.

The shape of the release: autosync keeps a folder on the server, and that
folder is usually not the one the editor has open. So it has to find the other
checkouts, know which of them the work is happening in, survive the window
closing, know what git would ignore, keep what it is about to overwrite, and
refuse to be two writers at once. Each of those is a bullet below.

The two that were not about autosync: the extension has never checked an SSH
host key, and every connection here authenticates with a password out of
`sftp.json` - so whatever answered got the password. And a watcher uploading
whatever changes will upload `.vscode/sftp.json` unless something stops it,
which is the password for the server it is uploading to.

### Added

- SSH host keys are checked before anything is sent. The extension has never
  done this: whatever answered on port 22 got the password out of `sftp.json`,
  and with autosync opening connections on its own that is worth closing.
  `~/.ssh/known_hosts` is read first, so hosts already accepted in a terminal
  are not asked about again. A host with nothing on record shows its
  fingerprint and asks once. A key that has *changed* is refused, with both
  fingerprints shown and `Update the stored key` as the way through - the
  innocent explanation is common, the other one hands that connection's
  password to whoever is answering. A key marked `@revoked` is refused
  outright. `StrictHostKeyChecking` and `UserKnownHostsFile` in ssh config are
  honoured, which they were not: that file was read but only six directives
  were ever mapped out of it. `sftp.hostVerification` turns the whole thing
  off, `"hostVerification": false` does it for one connection.

- `SFTP: Autosync Worktree` and `SFTP: Stop Autosync Worktree`, on a connection in
  the Remote Explorer and on a folder in the file explorer: upload everything
  that changes in a chosen folder, saved in this window or not. In a git
  repository the folders on offer are its worktrees - a checkout the editor
  does not have open - an agent's checkout of a branch, typically nowhere near
  the workspace, and clones of the same repository too, matched on the remote
  they came from because nothing else relates them. The list is ordered by
  which was written in most recently and says how long ago, since that is the
  question behind it. Two kinds git reports are left out, with the count
  shown: one sitting on a commit rather than a branch, since nothing tracks
  it, and one nested inside another checkout's `.git`, `.vscode` or `.claude`,
  since the thing deployed there is the checkout around it. Agent tooling
  leaves a lot of both behind - on one real project, four out of six.
  `sftp.autosync.showEveryCheckout` brings them back. Where to search
  beyond the folder holding the project is `sftp.autosync.searchPaths`. Outside a repository there is one candidate,
  the project folder itself. One folder at a time, chosen deliberately; while
  anything is syncing, this window's own upload-on-save stands down and says
  so. While it runs it keeps looking, once a minute, for another checkout of
  the same project being written in more recently than the one going to the
  server, and offers to switch to it - which is the case that matters and the
  one watching for a worktree to be *created* missed, since an agent picking
  up a checkout that already exists creates nothing. Once per checkout, only
  about ones the picker would offer, and only while something is already
  syncing. Choosing one
  offers to catch the server up first - the files that checkout has and the
  deployed branch does not, worked out from git rather than from the server.
  Connections that are autosyncing carry a badge in both explorers - one
  badge for this window's own folder and another, in a warning colour, when
  the folder being deployed is one this window does not have open, since that
  is the case where your own saves are standing down.

  What goes up is what git would keep: `git check-ignore` is asked about each
  batch, so an `npm install` in a watched checkout no longer sends
  `node_modules` to the server. Asked once per batch and once per directory
  rather than once per file, which is the difference between 80 milliseconds
  and four minutes for a big install.

  Nothing is dropped any more. An upload that fails goes back in the queue
  behind a cooldown that grows with each further failure; what is still
  waiting when the window closes is written down and picked up when it opens
  again. Stopping autosync says how many files were still waiting.

  One writer per connection now holds across windows, not just within one.
  Two editors on the same project shared the store that says what is syncing
  but never heard about each other, so both would watch and - pointed at
  different checkouts - both would write to the same remote path. A claim file
  per connection settles it: a window that cannot take it asks whether to take
  it over, and the one that loses it stands down and says so. `autosync.sh`
  does this with a pidfile.

  `.git`, `.vscode` and `.claude` are never uploaded, whatever the ignore
  rules say. `.vscode` holds `sftp.json`, which holds the password for the
  server it would be uploaded to.

  Files removed from the branch are now removed from the server. Git's index
  is what is watched, not the filesystem - a build clearing a folder, an editor
  swapping a file out and back and a branch switch all make files disappear,
  and none of them mean the file has left the project. The index is compared
  every two seconds, at the cost of one `lstat` unless git actually wrote it,
  and a linked worktree's own index is read rather than the repository's
  shared one. The copy is kept before the file goes, as it is before an
  overwrite. A folder that is not a checkout has no index to consult and still
  follows `watcher.autoDelete`.

  The catch-up now asks what it should cover. Where there is a branch, git
  answers exactly as before. Where there is not - a plain folder, or a
  checkout on a commit - the offer is by time: the last hour, 24 hours, 7
  days, or everything - and "what is not committed yet", which assumes nothing
  about what the server already has, the backfill `autosync.sh` does even in
  its monitor-only mode. Every catch-up uploads newest-first, so the file you
  just edited lands in a second rather than after the backlog. Catch-ups and restores upload through the connection's
  own transfer machinery, so `concurrency`, `verifyTransfer` and `useTempFile`
  apply to them as they do to every other upload.

  `sftp.autosync.settleSeconds` and `sftp.autosync.retrySeconds` set the two
  waits. A connection with a `context` now deploys the right folder of a
  worktree rather than the checkout root.

  Autosync survives quitting the editor. It never actually resumed before -
  it asked which connections were syncing before any connection had been
  built, so the answer was always none - and saving `sftp.json`, which throws
  every connection away and makes new ones, left it bound to disposed
  services. Both are fixed by binding after the connections exist and again
  whenever they change. On resume, what was queued is picked up, and the
  folder is asked what has been written since the connection was last
  watching it, so changes made while the window was closed go up too. Uploads
  only; a file deleted while nothing was watching leaves nothing to notice.
- `SFTP: Remove Files Deleted from the Project`, on a connection in the Remote
  Explorer: asks git what the project has deleted over its history and offers
  to take those files off the server, keeping a copy of each first. A server
  accumulates - downloads write and never remove, a deploy uploads what exists
  rather than removing what stopped existing, and autosync only removes what
  leaves the index while it is watching. This and `Sync Local -> Remote` with
  `syncOption.delete` answer different questions: that one lists the server and
  removes whatever is not on this machine, which is complete and includes every
  runtime directory, upload folder and cache the repository ignores; this one
  can only ever name a path git once tracked. Offered again after an
  `Everything in the folder` catch-up, since uploading everything the project
  has says nothing about what it used to have.
- `Switch Autosync Worktree`, beside `Stop Autosync Worktree` while a
  connection is syncing and in place of `Autosync Worktree`. In the Remote
  Explorer which of the two appears is decided per connection rather than per
  window - the tree item carries whether that connection is syncing - so a
  workspace with twenty-eight connections no longer labels all of them by what
  one of them is doing. `Stop` and the reveal commands became precise the same
  way.
- `Reveal Autosynced Folder in Finder` and `Reveal Autosynced Folder in
  Terminal`, under the autosync entries in both explorers, and only while a
  connection is syncing a folder this window does not have open. Nothing on
  screen leads to that folder otherwise - the file explorer shows this
  window's project, the Remote Explorer shows the server, and the branch name
  is not a path. The terminal is the machine's own, not the built-in one.
- Before autosync first writes over a file in a session, the server's copy is
  fetched and kept - once per file per session, so the cost is one extra fetch
  per file a session touches. If the server cannot be reached to make that
  copy the file is not overwritten but retried, because that is exactly the
  case where an overwrite would destroy the only copy of what was there.
  `SFTP: Restore Server to an Earlier Point`, on a connection in the Remote
  Explorer, puts a server back: pick a session and every file it or a later
  one wrote over returns to the earliest copy from that moment, which is what
  it was before anything in that window touched it. Files that were not on the
  server then are removed, counted separately in the confirmation. Sessions are
  swept after `sftp.autosync.backupDays` (30), whole sessions at a time.

## 2.0.0 - 2026-09-19

The first release of this fork. Major rather than minor because four things
behave differently on the same configuration, and because the version line
now diverges from upstream's.

### Breaking

- FTP listings ask for hidden files (`showHiddenFiles`, on by default), so
  dotfiles that were previously invisible now appear in the explorer and are
  included by anything that walks a directory. Set it to `false` for the old
  behaviour.
- `remoteExplorer.filesExclude` replaces the built-in defaults instead of
  adding to them, which makes `[]` a way to see everything. A configuration
  relying on the old additive behaviour will now hide less.
- Operations no longer wait indefinitely: `operationTimeout` (60s) bounds a
  command, and a transfer that makes no progress for that long is abandoned
  and retried. Set it to `0` to wait forever as before.
- Transfers are verified by size on every path, not only the direct one, so a
  transfer that previously reported success on a short write now fails.
  Disable per connection with `verifyTransfer: false`.

### Added

- `Reveal in Finder`, above `Reveal in Explorer` in the Remote Explorer's
  menu, on anything that has been downloaded: opens the system's file manager
  on the local copy. `Reveal in File Explorer` on Windows, `Open Containing
  Folder` on Linux.
- `Reveal in Terminal`, on folders in both explorers: opens the machine's own
  terminal on that folder rather than the editor's built-in one, honouring
  `terminal.external.*Exec`.
- `Clear Local Folder`, under `Download Scripts` in the Remote Explorer's
  menu on folders and roots: deletes the local copy of a folder and everything
  in it, so a download can
  start from nothing. `Download Scripts` writes files and never removes them,
  so a folder downloaded across a year of deploys holds files the server
  deleted months ago. Asked first, with the count and the size; moved to the
  trash where the system supports it; never anything the connection ignores,
  and never anything on the server. Not offered at all on anything whose local
  copy sits in a repository, its own or one above it.

- The denied-files list covers the credential files of other ecosystems:
  `.npmrc`, `.pypirc`, `.my.cnf`, `.s3cfg`, `.boto`, `.dockercfg`, an AWS
  `credentials` file, `kubeconfig`, Rails `secrets.yml` and
  `credentials.yml.enc`, `*.tfvars`, `*.ppk` and `*.kdbx`. INI and YAML are
  outlined like the rest, so these answer with their names too.
- A note store records which connection it belongs to, and a connection that
  no longer answers to the id its notes were filed under takes them back at
  startup - after a rename, a new hostname, a different port, a renamed
  account, a move from FTP to SFTP, or a change to how ids are derived. A
  password was never part of either, so changing one moves nothing. Where two
  connections could claim the same notes, neither gets them. Cached files
  can be fetched twice; a note is the only thing in that cache that cannot.
- A description is a short line and, optionally, the synthesis behind it. The
  line appears beside the path in `tree`; the synthesis is where the
  understanding accumulates, read and rewritten whole by each person who
  learns something. The line it replaced is kept as an undo.
- A description is anchored to what the file's bytes hash to, not only to its
  timestamp and size. Every deploy here is an upload, and an upload restamps
  every file it copies - so redeploying unchanged code used to mark every
  description on a server stale at once. A file whose bytes are the same now
  keeps its description however often it is uploaded, and one whose bytes
  differ has moved on however the timestamp reads.
- `read` asks for a description when a substantial file has none, for a
  correction when the one it has describes an older version, and for a better
  line when reading has turned up something the description does not say -
  once each, where the understanding is. A file's description is capped at
  300 characters because it shares a line with its path; a project's at 1500. The only prompt used to be in `tree`,
  which is where you go before you understand anything.
- `note` without a path records what a whole project is for, which `overview`
  and `servers` then report. `overview` could only repeat what composer.json
  said about itself, and said nothing at all about a project without one.
- A denied file can now answer with the names in it. `.env` and a JSON
  credentials file are served as their keys with every value withheld -
  including the values that look harmless - so an agent can see that
  `STRIPE_SECRET_KEY` is configured without seeing it. Read into memory over
  the socket and dropped: nothing is written to this machine. A file whose
  names cannot be told from its values with certainty, such as a private key
  or `.htpasswd`, is refused exactly as before.

- An MCP server inside the editor, offering the configured connections to
  local AI clients as twelve read-only tools: listings, file reads, text and
  path search, a tree annotated with what each file is for, earlier versions,
  and diffs between any two of the server, the working copy, an earlier
  version, or another connection. Off by default (`sftp.mcp.enabled`).
- `passwordManager` / `passphraseManager`: keep a password in the editor's
  secret store, the macOS keychain, or behind a command, and migrate one out
  of `sftp.json`.
- `SFTP: Download Scripts` — the text of a project without the media.
- A check before a download overwrites newer local work, with a diff, and a
  copy of whatever a download replaced (`SFTP: Restore File Replaced by a
  Download`).
- `operationTimeout`: a command must answer within it, and a transfer must
  not go silent for longer than it.
- A note in the log when an FTP server's clock is wrong, as opposed to in a
  different timezone. Measured for free from a file the server stamped
  itself, on servers that cannot set timestamps on upload. Reported rather
  than corrected: a clock minutes out is a server to fix.
- Hidden files in FTP listings, via `LIST -a` with a fallback.
- Plain FTP connections are attempted over TLS, and kept that way for as long
  as they keep working. Many hosts accept FTPS without anyone configuring it;
  the ones that cannot carry it are discovered by trying rather than by
  asking, since a server can encrypt commands and still fail on the data
  connection. Any trouble - including a hang - drops that server back to the
  configuration as written for a day. An upgraded connection is encrypted but
  does not verify the certificate; `"secure": true` still means what it
  meant. Off with `sftp.upgradePlainFtp`.
- A check before connecting to a server that would receive the password as
  readable text: plain FTP sends `USER` and `PASS` unencrypted, and the
  connection now waits for an answer rather than sending it. SFTP and FTPS are
  never warned about. Off with `sftp.warnOnCleartextPassword`.
- A warning at startup when another SFTP extension is enabled alongside this
  one, since both answer the same commands and the same `uploadOnSave`.
  Nothing needs importing from it: every setting either extension reads is
  `sftp.*` or `.vscode/sftp.json`, so an existing configuration is already in
  use here.
- An end-to-end test suite (`npm run e2e`) against a real SFTP server started
  inside the test process.

### Changed

- `sftp.mcp.callTimeout` defaults to 45 seconds rather than two minutes, which
  is below what MCP clients usually wait. A call that overruns it returns what
  it found and where to carry on; one that overruns the client returns nothing.
- Cache folders from the old connection numbering are removed at startup.
- A connection's MCP id is derived from where it points - project, host,
  account, path and name - rather than from the
  order the editor loaded it in, so it survives a reload - and so do the
  cached files and notes kept under it. A name from `servers` works in place
  of an id when only one connection answers to it.
- Log lines name the connection they are about: `[info:staging]` rather than
  `[info]`. With more than one server configured, a timeout, a clock offset or
  a refused upgrade said nothing about whose it was.
- A walk's `depth` counts the directory it starts in as the first level, the
  way `find -maxdepth` and `tree -L` do, so `depth: 1` lists one directory.
  It also no longer ends the whole walk: reaching the limit in one branch used
  to stop everything after it, which quietly hid shallow directories that were
  listed later.
- FTP transfers use a pool of control connections, and SFTP transfers are
  pipelined, instead of moving one file at a time with one request in flight.
- A server whose clock disagrees with this machine is measured once and
  corrected for.
- Every transfer is verified by size before a temp file replaces a real one,
  on every code path rather than only the direct one.

### Fixed

- SSH connections failed outright: an event handler was registered by calling
  the function rather than passing it.
- The webpack build failed on two constants used without being imported.
- `getFileSystemPath` took a URI while its callers pass a path string.
- Every FTP connection left its connect-deadline timer running after the
  connection was made.
- An MCP connection id addressed whichever connection the editor happened to
  number that way this session. After a reload the same id meant a different
  server: path containment caught the obvious cases, and two servers that
  both keep their site under `/httpdocs` it could not. The cached files and
  the notes under that id were mixed up the same way.
- Redaction covers the shapes other ecosystems use: dotted property keys
  (`spring.datasource.password`), Go's `:=`, keys the secret word is only
  part of (`secret_key_base`), .NET and Spring XML attributes, base64 in a
  Kubernetes secret, `curl -u`, SQL `IDENTIFIED BY`, a literal behind a `??`
  fallback, and tokens from Anthropic, GitLab, npm, Shopify, DigitalOcean
  and Hugging Face. Measured against a corpus from those ecosystems it went
  from 17 of 32 to 31 of 32.
- Redaction read straight past the way credentials are actually spelled.
  `DB_PASSWORD`, `smtp_password`, `api_secret`, `MAIL_PASSWORD`: the rule
  wanted a word boundary before the name, and `_` is a word character, so a
  name after an underscore was not a name. A file could come back with its
  credentials in it.
- Redaction could also eat code: `'x-api-key: ' . $config['key']` reads as a
  quoted value if you take the closing quote for an opening one, and what
  was replaced with a marker was the concatenation. A marker where code was
  looks exactly like a redaction somebody meant.
- `local-copy`, `history` and `diff` returned structured output they never
  declared, and left their substance out of it - the same fault as `read`,
  one layer down. A tool's structured content is now sent only when it
  published a schema for it, and the five tools that were returning it
  without one publish schemas that carry the file, the version and the diff.
- `read` returned everything about a file except the file to any client that
  reads structured output, which is what a client does once a tool declares a
  schema. The contents are now in both halves of the reply.
- Every SFTP file read failed with “isDate is not a function”. The shim for
  ssh2 was installed when the extension activated, and ssh2 takes its copy of
  what the shim patches while the entry module's imports are still being
  evaluated. Listings, which encode no file attributes, worked throughout.
- A tree or search that stopped early said only that it had “hit its limit”.
  It now says which limit - depth, file count or time - because the way out of
  each is a different one.

---

## Upstream releases

Everything below is the work of liximomo and Natizyskunk, kept as they wrote
it.

## 1.16.3 - 2023-06-16
* [#356] New Feature : Upload to all profiles (Pull request [#313](https://github.com/Natizyskunk/vscode-sftp/pull/313) from @wewawa vscode-sftp:create_multi_command).
* [#357] Fix : Correcting Typo 'avaliable' => 'available' (Pull request [#343](https://github.com/Natizyskunk/vscode-sftp/pull/343) from @kjo-sdds vscode-sftp:develop).
* [#358] Permissions : Add filePerm and dirPerm options for configuring permissions (Pull request [#347](https://github.com/Natizyskunk/vscode-sftp/pull/347) from @Jchase2 vscode-sftp:develop).
* [#359] Fix : Correcting sftp connection with public key (Pull request [#350](https://github.com/Natizyskunk/vscode-sftp/pull/350) from @inu1255 vscode-sftp:develop).
* Upgrade `ssh2` version to official v1.13.0 by @mscdex.

## pre-1.16.2 - 2022-11-30
* [#271] Fix case change of file name not sent correctly (Pull request [#249](https://github.com/Natizyskunk/vscode-sftp/pull/249) from @NyaPPuu vscode-sftp:fix_rename).
* [#272] Update npm `types/node` depedency to v9.6.51.

## 1.16.1 - 2022-11-02
* [#251] Add multiple select + Update `Download File` & `Downalod Folder` commands to the remote view + Add `Upload File` & `Upload Folder` commands to the remote view (Pull request [#221](https://github.com/Natizyskunk/vscode-sftp/pull/221) from @NyaPPuu vscode-sftp:add_multiple_select).

## 1.16.0 - 2022-10-29
* [#242] Add order option and fix typos in docs (Pull request [#157](https://github.com/Natizyskunk/vscode-sftp/pull/157) from @NyaPPuu vscode-sftp:add_order_option).
* [#243] Fix refresh when creating/deleting file/folder + Fix 'Reveal in Remote Explorer' and Refresh Button in Remote Explorer. (Pull request [#159](https://github.com/Natizyskunk/vscode-sftp/pull/159) from @NyaPPuu vscode-sftp:fix_refresh).
* [#244] Cleanup Text in Markdown Files (Pull request [#213](https://github.com/Natizyskunk/vscode-sftp/pull/213) from @BrayFlex vscode-sftp:develop).

## 1.15.20 - 2022-08-28
* Fix typo 'worksapce' to 'workspace' (Pull request [#158](https://github.com/Natizyskunk/vscode-sftp/pull/158) from @NyaPPuu vscode-sftp:fix_typo).
* Add `Download File` & `Downalod Folder` commands to the remote view (Thanks to @mrandrey on issue #97).
* Update npm `types/fs-extra` depedency to v9.0.13 (Pull request [#204](https://github.com/Natizyskunk/vscode-sftp/pull/204) from @dependabot vscode-sftp:dependabot/npm_and_yarn/types/fs-extra-9.0.13).
* Update npm `typescript-tslint-plugin` depedency to v1.0.2 (Pull request [#206](https://github.com/Natizyskunk/vscode-sftp/pull/206) from @dependabot vscode-sftp:dependabot/npm_and_yarn/typescript-tslint-plugin-1.0.2).
* Update npm `tslint` depedency to v6.1.3 (Pull request [#207](https://github.com/Natizyskunk/vscode-sftp/pull/207) from @dependabot vscode-sftp:dependabot/npm_and_yarn/tslint-6.1.3).
* Update npm `ts-loader` depedency to v9.4.1 (Pull request [#208](https://github.com/Natizyskunk/vscode-sftp/pull/208) from @dependabot vscode-sftp:dependabot/npm_and_yarn/ts-loader-9.4.1).
* Update npm `typescript` depedency to v3.9.7.
* Update npm `jest` depedency to v29.0.3.

## 1.15.19 - 2022-08-26
* [#72] Change `uploadOnSave` default value from true to false.

## 1.15.18 - 2022-08-26
* Update npm `async` depedency to v3.2.4.
* Update npm `fs-extra` depedency to v10.1.0.
* Update npm `tmp` depedency to v0.2.1.
* Update npm `upath` depedency to v2.0.1.

## 1.15.17 - 2022-08-26
* Upgrade `ssh2` version to official v1.11.0 by @mscdex.

## 1.15.16 - 2022-05-26
* Reorder cipher and serverHostKey algorithms.
* Update [FAQ.md](https://github.com/Natizyskunk/vscode-sftp/blob/master/FAQ.md), and [documentations](https://github.com/Natizyskunk/vscode-sftp/tree/master/docs).

## 1.15.15 - 2022-08-21
* Fix "Open SSH in Terminal" not working because "terminal.integrated.shell.windows" is deprecated and fix typo `src/commands/commandOpenSshConnection.ts`. (Pull request [#155](https://github.com/Natizyskunk/vscode-sftp/pull/155) from @mean-cj vscode-sftp:patch-2).

## 1.15.14 - 2022-05-06
* Update npm `async` depedency to v2.6.4.
* Update npm `minimist` depedency to v1.2.6.

## 1.15.13 - 2022-02-11
* Add support for OpenSSH v8.8 SSH private key by using SHA-2 instead of SHA-1 to fix SSH public key signatures. (See issue [#112](https://github.com/Natizyskunk/vscode-sftp/issues/112)).

## 1.15.12 - 2022-02-11
* Add deletions support to "Upload Changed files" command. (Pull request [#113](https://github.com/Natizyskunk/vscode-sftp/pull/113) from @brykov vscode-sftp:master merged inside [#117](https://github.com/Natizyskunk/vscode-sftp/pull/117)).

* ## 1.15.11 - 2022-02-09
* Enhance sftp interactiveAuth mode (See [Wiki](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration#interactiveauth)). (Pull request [#94](https://github.com/Natizyskunk/vscode-sftp/pull/94) from @lacastorine vscode-sftp:lacastorine merged inside [#114](https://github.com/Natizyskunk/vscode-sftp/pull/114)).

## 1.15.10 - 2021-11-22
* Update npm `json-schema` devDepedency to v0.2.3.

## 1.15.9 - 2021-11-21
* Remove ssh configuration bug introduced in pull request [#69](https://github.com/Natizyskunk/vscode-sftp/pull/69) from @clemyan while we can find another solution.

## 1.15.8 - 2021-11-12
  * Fix 'Upload Changed Files' & 'No Such File' bugs (Commit [fix upload changed files](https://github.com/wandway/vscode-sftp/commit/775016788e4c59db901dc68a20c1f61ebcca7bc7#diff-20516d8841b4891f1926f1e40e447e99e0575a5e36ba6814f6b85b45db1b8fbb) from @wandway vscode-sftp:master).
  * Make the 'Upload Changed Files' command visible and add a default keyboard shortcut (Ctrl+Alt+U) to call it (Merged pull request [#84](https://github.com/Natizyskunk/vscode-sftp/pull/84) from @PaPa31 vscode-sftp:master). See [FAQ](https://github.com/Natizyskunk/vscode-sftp/blob/master/FAQ.md#clicking-upload-changed-files-does-not-work)).
  * Update Webpack from 4.39.2 to 5.0.0.
  * Update Webpack-cli from 3.3.7 to 4.7.0.

## 1.15.7 - 2021-11-12
  * Upgrade `ssh2` version to official v1.5.0 by @mscdex.

## 1.15.6 - 2021-10-27
  * Fix ssh configuration resolution (Merged pull request [#69](https://github.com/Natizyskunk/vscode-sftp/pull/69) from @clemyan vscode-sftp:fix-ssh-config).

## 1.15.5 - 2021-10-27
  * Update mtime after file was saved before upload (Merged pull request [#75](https://github.com/Natizyskunk/vscode-sftp/pull/75) from @viperet vscode-sftp:save_before_upload_mtime).
  * Add pull request issue template.
  * Add funding/sponsors page.
  * Add code scanning alert.

## 1.15.4 - 2021-10-04
  * Remove error message when calling sftp.sync.remoteToLocal command in vscode tasks.json.

## 1.15.3 - 2021-09-10
  * Upgrade `ssh2` version to official v1.4.0 bcy @mscdex.

## 1.15.2 - 2021-08-24
  * Fix the `useTempFile` bug (Merged pull request [#41](https://github.com/Natizyskunk/vscode-sftp/pull/41) from @kripper vscode-sftp:master).
  * Change `useTempFile` default value from true to false.
  * Fix the "Cannot read property 'handle' of undefined" bug (related to `useTempFile` bug) [TypeError: Cannot read property 'handle' of undefined](https://github.com/Natizyskunk/vscode-sftp/issues/43).
  * Fix the "fd argument must be of type number. Received undefined" bug (related to `useTempFile` bug) [TypeError since last update (The "fd" argument must be of type number.)](https://github.com/Natizyskunk/vscode-sftp/issues/34).
  * Fix the "Permission denied" bug when uploading.
  * New option [openSsh](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration#openssh) (Pull request [#42](https://github.com/Natizyskunk/vscode-sftp/pull/42) from @kripper vscode-sftp:atomic-rename merged inside [#45](https://github.com/Natizyskunk/vscode-sftp/pull/45)).
  * Update of the wiki to add support for openSsh option.

## 1.15.1 - 2021-08-24
  * Add the `useTempFile` option to the test configuration spec.
  * Fix get target mode error && add more precise logger-infos for tranfer tasks (Merged pull request [#29](https://github.com/Natizyskunk/vscode-sftp/pull/29) from @kripper vscode-sftp:master).

## 1.15.0 - 2021-08-23
  * New option [useTempFile](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration#usetempfile) (Merged pull request [#29](https://github.com/Natizyskunk/vscode-sftp/pull/29) from @kripper vscode-sftp:master).
  * Update of the wiki to add support for useTempFile option.

## 1.14.0 - 2021-08-06
  * Update of the FAQ to add support for old/legacy systems.
  * switching from beta to stable.

## 1.14.0-beta - 2021-07-15
  * Add `create remote file` and `create remote folder` commands (Merged pull request [#18](https://github.com/Natizyskunk/vscode-sftp/pull/18) from @mathsgod vscode-sftp:master).

## 1.13.6 - 2021-07-15
  * Fix syntax in `src\fileHandlers\transfer\__tests__\transfer-test.ts`.

## 1.13.5 - 2021-07-10
  * Reorder test parameters for `keepalive`.
  * Add v1.13.5-beta. Only use beta version if you still encounter the "REQUEST_FAILURE" error like described in those two issues : [Buffering on save file after 15 minute](https://github.com/Natizyskunk/vscode-sftp/issues/7) & [Infinite spinner on file save after server rest connection with client](https://github.com/Natizyskunk/vscode-sftp/issues/8).

## 1.13.4 - 2021-07-10
  * Fix "Error with the transfer direction."
  * Add loggers for transfer informations.

## 1.13.3 - 2021-07-09
  * re-add braces >=2.3.1 to package.json.
  * re-add yargs-parser ^20.2.4 to package.json.
  * Remove `yarn.lock`.
  * Add `package-lock.json`.
  * Fix Writing CHANNEL_DATA (0) / Writing FSETSTAT (Merged pull request [#12](https://github.com/Natizyskunk/vscode-sftp/pull/12) from @zarausto vscode-sftp:patch-1).
  * Fix transfer-test for Windows platform (Merged pull request [#11](https://github.com/Natizyskunk/vscode-sftp/pull/11) from @alex1504 vscode-sftp:fix-transfer-test).

## 1.13.2 - 2021-07-07
  * remove braces >=2.3.1 to package.json.
  * remove yargs-parser ^20.2.4 to package.json.
  * Remove the fix for the "No such file" error on VSCode 1.56 since it's been implementend in the new ssh2 v1.1.0 npm package (Commit [SFTP: explicitly set autoClose option for node 14+](https://github.com/mscdex/ssh2/commit/c0de05d186065ad4081b98d2f7aa0fe22161ec09) from @mscdex ssh2:master).

## 1.13.1 - 2021-07-06
  * Add braces >=2.3.1 to package.json.
  * Add node-notifier >=8.0.1 to package.json.
  * Add yargs-parser ^20.2.4 to package.json.
  * Changing publisher and repo links.
  * Fixed error "No such file" on VSCode 1.56.
  * Fixed issue with uploading of file which has unsaved changes.

## 1.13.0 - 2021-07-06
  * Upgrade `ssh2` version to official v1.1.0 by @mscdex.

## 1.12.10 - 2021-05-15
  * Improve sftp reliability.

## 1.12.3 - 2019-04-27
  * Minor improvements.
  * Bug fix.

## 1.12.1 - 2019-03-28
  * Fix [#510](https://github.com/liximomo/vscode-sftp/issues/510).

## 1.12.0 - 2019-03-21
  * new option [sshCustomParams](https://github.com/liximomo/vscode-sftp/wiki/SFTP-only-Configuration#sshcustomparams).

## 1.11.0 - 2019-03-15
  * Save before upload.
  * Fix [#490](https://github.com/liximomo/vscode-sftp/issues/490).

## 1.9.4 - 2019-02-26
  * Fix sshConfig file not work.
  * Open SSH in Terminal can enter to remote path.

## 1.9.3 - 2019-01-30
  * New icon for RemoteExplorer. Thanks [niccolomineo](https://github.com/niccolomineo) and [jonbp](https://github.com/jonbp).
  * Change `port` to number in the generated configuration.

## 1.9.2 - 2019-01-22
  * Fix [#388](https://github.com/liximomo/vscode-sftp/issues/388).
  * Fix [#456](https://github.com/liximomo/vscode-sftp/issues/456).
  * Fix [#459](https://github.com/liximomo/vscode-sftp/issues/459).

## 1.9.0 - 2019-01-08
  * Control files and folders to show or hide in Remote Explorer by `remoteExplorer.filesExclude`. [#410](https://github.com/liximomo/vscode-sftp/issues/410).
  * Suport new OpenSSH key format. [#391](https://github.com/liximomo/vscode-sftp/issues/391).
  * Improve performance.

## 1.8.4 - 2018-12-16
  * Fix ignore not work when use profile. [#428](https://github.com/liximomo/vscode-sftp/issues/428).

## 1.8.3 - 2018-12-14
  * Upgrade VSCode engine version.

## 1.8.2 - 2018-12-13
  * Add **Collapse All** action to RemoteExplorer.

## 1.8.0 - 2018-12-06
  * New command [Upload Changed Files](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-upload-changed-files).
  * Fix bugs.

## 1.7.6 - 2018-11-22
  * Reduce *80%* startup time.
  * Fix [#396](https://github.com/liximomo/vscode-sftp/issues/396).

## 1.7.5 - 2018-11-15
  * Fix [#394](https://github.com/liximomo/vscode-sftp/issues/394).

## 1.7.4 - 2018-11-09
  * Fix [#362](https://github.com/liximomo/vscode-sftp/issues/362).
  * Don't upload the file when it's in downloading. [#390](https://github.com/liximomo/vscode-sftp/issues/390).

## 1.7.3 - 2018-11-03
  * New configuration [limitOpenFilesOnRemote](https://github.com/liximomo/vscode-sftp/wiki/Configuration#limitopenfilesonremote).
  * Show `upload file` context menu in SCM.

## 1.7.2 - 2018-10-29
  * New command [Open SSH in Terminal](https://github.com/liximomo/vscode-sftp/wiki/Commands#open-ssh-in-terminal).

## 1.7.1 - 2018-10-25
  * New setting [downloadwhenopeninremoteexplorer](https://github.com/liximomo/vscode-sftp/wiki/Setting#downloadwhenopeninremoteexplorer).
  * fix some bugs.

## 1.7.0 - 2018-10-19
### New Features
  * New command [Upload Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-upload-active-folder).
  * New command [Download Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-download-active-folder).
  * New command [List Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-list-active-folder).
  * New command [Cancel All Transfers](https://github.com/liximomo/vscode-sftp/wiki/Commands#cancel-all-transfers).
  * New configuration [remotetimeoffsetinhours](https://github.com/liximomo/vscode-sftp/wiki/Configuration#remotetimeoffsetinhours).

## 1.6.0 - 2018-10-12
### New Features
  * New command [Sync Local -> Remote](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-local---remote).
  * New command [Sync Remote -> Local](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-remote---local).
  * New command [Sync Both Directions](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-both-directions).
  * New configuration [syncOption](https://github.com/liximomo/vscode-sftp/wiki/Configuration#syncoption) for `Sync` command.

### Breaking Changes
  * Remove Command `SFTP: Sync To Remote`.
  * Remove Command `SFTP: Sync To Local`.
  * Remove configuration option `syncModel`.

## 1.5.13 - 2018-10-08
* Fix [#344](https://github.com/liximomo/vscode-sftp/issues/344).

## 1.5.12 - 2018-10-07
* New command `Diff Active File with Remote`.
* Command `Set Profile` can receive an argument from keybindings.

  ```json
  {
    "key": "ctrl+shift+cmd+d",
    "command": "sftp.setProfile",
    "args": "dev"
  }
  ```

## 1.5.10 - 2018-09-28
* Fix [#332](https://github.com/liximomo/vscode-sftp/issues/332).

## 1.5.9 - 2018-09-27
* Fix [#330](https://github.com/liximomo/vscode-sftp/issues/330).

## 1.5.8 - 2018-09-25
* Show name in the remote explorer. [#315](https://github.com/liximomo/vscode-sftp/issues/315).
* Fix [#308](https://github.com/liximomo/vscode-sftp/issues/308).

## 1.5.0 - 2018-09-13
### New Features
  * new [alt commands](https://github.com/liximomo/vscode-sftp#alt-commands) `Force Download` and `Force Upload`. This allow you to download/upload files but disregard ignore rules.

### Breaking Changes
  * Rename command `sftp.trans.remote(SFTP: Upload)` to `sftp.upload.activeFile` and command `sftp.trans.local(SFTP: Download)` to `sftp.download.activeFile`. Please update your keybinding if you've used one of these commands.

### Deprecated
  * Commands `SFTP: List` and `SFTP: List All` will be removed in favor of `Remote Explorer` in next release.

## 1.4.1 - 2018-09-03
### Feature
  * [Configuration in User Setting](https://github.com/liximomo/vscode-sftp#configuration-in-user-setting) Configuration your remote in User Setting.

### Fix
  * Fix sshConfig file not overwriting default configuration. [#305](https://github.com/liximomo/vscode-sftp/issues/305).

## 1.4.0 - 2018-08-27
### Feature
  * [Connection Hopping](https://github.com/liximomo/vscode-sftp#connection-hopping) allow you to connection to a target server through a proxy with ssh protocol.

## 1.3.9 - 2018-08-14
* Fix [#286](https://github.com/liximomo/vscode-sftp/issues/286).
* Fix [#287](https://github.com/liximomo/vscode-sftp/issues/287).

## 1.3.8 - 2018-08-13
* Fix [#285](https://github.com/liximomo/vscode-sftp/issues/285).

## 1.3.7 - 2018-08-10
* Fix bug in `remoteExplorer.refresh`.

## 1.3.0 - 2018-08-02
### New Features
  * [Remote Explorer](https://github.com/liximomo/vscode-sftp#remote-explorer).

## 1.2.7 - 2018-07-27
### New Features
  * `ignoreFile` [option](https://github.com/liximomo/vscode-sftp/wiki/Configuration#ignorefile).

## 1.2.3 - 2018-06-19
### New Features
  * [Swtichable Profiles](https://github.com/liximomo/vscode-sftp/#profiles).

## 1.2.0 - 2018-06-19
* Support [SSH configuration file](https://www.ssh.com/ssh/config/). The default ssh configuration file is `~/.ssh/config`. This can be changed by `sshConfigPath` option.

## 1.1.12 - 2018-06-08
* Fix [#200](https://github.com/liximomo/vscode-sftp/issues/200). Thanks for [Gergo Koos](https://github.com/gergokoos).

## 1.1.11 - 2018-05-21
* Fix [#198](https://github.com/liximomo/vscode-sftp/issues/198).

## 1.1.10 - 2018-05-18
* Show open folder prompt in `sftp:config` command.
* Fix [#174](https://github.com/liximomo/vscode-sftp/issues/174).

## 1.1.9 - 2018-05-17
* Add `confirm` option to `downloadOnOpen`.
* Fix [#160](https://github.com/liximomo/vscode-sftp/issues/160).
* Fix [#195](https://github.com/liximomo/vscode-sftp/issues/195).

## 1.1.8 - 2018-05-15
* Some UX improvements.
    * Only show `sftp` menu when extension get activated (Thanks [@mikolino](https://github.com/mikolino)).
    * Remove some unnecessary warning.
* Improve ftp reliability.
* Upgrade `ssh2` version.

## 1.1.7 - 2018-03-31
* `name` [configuration](https://github.com/liximomo/vscode-sftp#full-config).
* Fix bugs.

## 1.1.6 - 2018-03-24
* Better procedure message in status bar.
* Fix sync error when synced target is not exist.
* Fix [#146](https://github.com/liximomo/vscode-sftp/issues/146).

## 1.1.5 - 2018-03-23
* Improve stability of `ftp` protocol.
* Fix document don't show automatically after select a file through `list` command.
* Fix [#113](https://github.com/liximomo/vscode-sftp/issues/113).

## 1.1.4 - 2018-03-21
* `connectTimeout` [config](https://github.com/liximomo/vscode-sftp#full-config).
* `downloadOnOpen` [config](https://github.com/liximomo/vscode-sftp#full-config).
* Fix ftp unexpectedly traverse up director [#80](https://github.com/liximomo/vscode-sftp/issues/80). Thanks for [Andrey Orst](https://github.com/andreyorst)'s help.

## 1.1.3 - 2018-03-18
* Remove default ignore configuration. No files will be ignored if you don't explicitly configuration `ignore` option. Related isuse [#138](https://github.com/liximomo/vscode-sftp/issues/138).
* Fix [#133](https://github.com/liximomo/vscode-sftp/issues/133).
* Fix [#136](https://github.com/liximomo/vscode-sftp/issues/136).


## 1.1.0 - 2018-03-13
* `diff` command.
* Fix [#113](https://github.com/liximomo/vscode-sftp/issues/113).
* Fix [#124](https://github.com/liximomo/vscode-sftp/issues/124).

## 1.0.5 - 2018-02-24
* Support [multi select in the Explorer](https://code.visualstudio.com/updates/v1_20#_multi-select-in-the-explorer).
* Fix some bugs.

## 1.0.4 - 2018-02-08
* New configuration option `concurrency`.
* New configuration option `algorithms`.
* Fix [#103](https://github.com/liximomo/vscode-sftp/issues/103).

## 1.0.3 - 2018-02-05
* Simplify default configuration file's content when exec `sftp: config`.
* Configuration autocomplete.
* Fix watcher stop work after 'download' or 'sync to local'.

## 1.0.2 - 2018-01-30
* Add FTPS support.
* Add passphrase/password dialog support.
* Fix configuration not found error after configuration file changed.
* Fix `sftp config` failed to show created configuration file in vscode.

## 1.0.0 - 2018-01-26
🎉🎉🎉This release include some new features, bugfixs and improvements. It may be bring some new bugs, welcome to feedback.

### New Features
* `list` and `list all` command.
  * `list` will list all remote files except those match your ignore rules.
  * `list all` will list all remote files.

  The target will be dowmload after you select. And it will be open in vscode if the target is a file.
* When you download a folder through a command, the vscode explorer will be refreshed when the command finish.

### Breaking Changes
* Change to git ignore [spec](https://git-scm.com/docs/gitignore). It's more powerful and concise. You may need to change your ignore configuration.


## 0.9.4 - 2017-12-18
* `Context` now receives a relative path.
* Fix [#69](https://github.com/liximomo/vscode-sftp/issues/69), [#70](https://github.com/liximomo/vscode-sftp/issues/70).

## 0.9.0 - 2017-12-16
* Add a option to configuration a local path that correspond to a remote path.
* Support multiple configurations in one configuration file.
* Remove `.sftpConfig.json` configuration file support.
* Remove none-worksapce-root configuration files support.

## 0.8.11 - 2017-11-30
* Fix ftp can't preserve file permissions.

## 0.8.10 - 2017-11-20
* Disable create configuration at none-workspace-root-folder.

## 0.8.9 - 2017-11-17
* Preserve file permissions.
* Better README thanks [kataklys](https://github.com/kataklys).
* Fix Empty (0kb) files when download and uplaod. Thanks for [kataklys](https://github.com/kataklys)'s help ([#33](https://github.com/liximomo/vscode-sftp/issues/33))
* Show a waring for existing none-worksapce-root configuration files. Previously you can create multiple configuration files anywhere under workspace. So you won't need to open multiple vscode instances to make `sftp` working in different folders. Sincle vscode support [Multi-root Workspaces](https://code.visualstudio.com/docs/editor/multi-root-workspaces). There is no necessary to support multiple configuration now. This will make `sftp` both simple and a bettern starup performace.

## 0.8.8 - 2017-11-11
### Bugfix
* Files is not correctly filtered at configuration setup.

## 0.8.7 - 2017-11-07
### Bugfix
* Configuration setup not work for directories whose name does end with `.vscode`.

## 0.8.6 - 2017-11-06
* Performance improvement.
* Show a waring to the old `.sftpConfig.json` file.

### Behaviour Change
Now `uploadOnSave` only happens on a vscode save opetarion. It used to happen on a disk save opetarion caused by anything.

## 0.8.5 - 2017-10-18
### Improvement
* support more cipher algorithms.

## 0.8.4 - 2017-10-10
### Improvement
* log more infos to output pannel.

## 0.8.3 - 2017-09-26
### Bugfix
* fix couldn't create configuration through file picker when no sub files in the directory.

## 0.8.2 - 2017-09-24
### Enhance
* Don't need to reload vscode after execute `SFTP: config` command.
* `SFTP: config` creates `sftp.json` now.

## 0.8.1 - 2017-09-22
### Bugfix
* WIN could not find configuration(path is not normalized).

## 0.8.0 - 2017-09-22
### Feature
* support multi-root workspace.

### Change
* Configuration file name is changing to `sftp.json` from `.sftpConfig.json` for concision.

### Bugfix
* fix a bug that always return the same ssh session when have multiple configurations in workspace.

## 0.7.11 - 2017-09-13
### Bugfix
* fix tribe retrive.

## 0.7.10 - 2017-09-13
### Bugfix
* fix configuration not found when have multiple configuration files in workspace.

## 0.7.9 - 2017-09-01
### Bugfix
* change tip text from uploading to sync when download and upload.

## 0.7.8 - 2017-08-20
### Bugfix
* Fix `command not found error` when no folder opened.

## 0.7.7 - 2017-07-25
### Bugfix
* Fix folder match of ignore.

## 0.7.6 - 2017-07-24
### Bugfix
* Fix [files in "ignored" directories are still uploaded](https://github.com/liximomo/vscode-sftp/issues/15). Thanks for [Tom Spence](https://github.com/tomjaimz)'s help.

## 0.7.5 - 2017-07-18
### Feature
* A new editor configuration `sftp.printDebugLog`, dafault with false.

## 0.7.4 - 2017-07-14
### Enhance
* Configuration validation failing at startup does not require a reload to make extension work.

## 0.7.3 - 2017-07-13
### Feature
* Configuration validation.

### Misc
* More accurate watcher description.

## 0.7.2 - 2017-07-04
### Feature
* Add a way to execute commands on all detected configuration root folders.(run commands throw command palette)

## 0.7.1 - 2017-07-04
### Bugfix
* Fix miss files because of throttle.

## 0.7.0 - 2017-06-30
### Breaking Change
* Now configuration files are located in .vscode folder. Just move every .sftpConfig.json to the .vscode folder of same hierarchy.

## 0.6.14 - 2017-06-29
### Enhance
* show authentication input as asterisk.

## 0.6.13 - 2017-06-28
### Feature
* ssh agent authentication.

## 0.6.12 - 2017-06-26
### Feature
* Interactive authentication.

## 0.6.11 - 2017-06-22
### Feature
* Ignore works for download/sync remote file to local.

## 0.6.10 - 2017-06-13
### Enhance
* Better log.

## 0.6.9 - 2017-06-11
### Bugfix
* Remove unnecessary error message.
* Sync blocks on symlink.

## 0.6.8 - 2017-06-09
### Enhance
* Activate the extension only when it needs to. You must have the vscode greater than 1.13.0.

## 0.6.7 - 2017-06-07
### Enhance
* Keeping active so you don't have to reload vscode to active sftp when create configuration file at the first time.

## 0.6.6 - 2017-06-06
### Bugfix
* Window can't auto create dir non-existing.

## 0.6.2 - 2017-06-05
### Bugfix
* Incorrectly configuration not found error popup.

## 0.6.1 - 2017-06-03
### Bugfix
* Don't watch file when there is no .sftpConfig file.

## 0.6.0 - 2017-06-02
### Feature
* Support ftp.

### Feedback
* More debug info.

### Bugfix
* Fix `SFTPFileSystem.rmdir` doesn't resolve correctly.
* Disable watcher on pulling files.
* Make true re-connect when it need to.

## 0.5.4 - 2017-05-30
### Feedback
* Better error log.
* Output debug info in sftp output channel.

### Bugfix
* Fix some files missed uploading when they has updated because of throttle.

## 0.5.3 - 2017-05-26
### Feature
* AutoSave now works even in external file update!🎉🎉🎉
* A new configuration `watcher`. Now there is a way to perceive external file change(create, delete).

## 0.5.2 - 2017-05-22
### Bugfix
* Running a command through shortcut couldn't find active document correctly.

### Feedback
* Show path that is relative to the workspace root instead of full path on status bar.

## 0.5.1 - 2017-05-22
### Enhance
* Provide a way to run command at the workspace root.

## 0.5.0 - 2017-05-19
### Feature
* Keep ssh connect alive (re-connect only when needed).

## 0.4.12 - 2017-05-18
### Bugfix
* Fix binary file upload.

## 0.4.11 - 2017-05-18
### Feedback
* Better status indication.

## 0.4.10 - 2017-05-18
### Bugfix
* Configuration file not found in windows.
* Check existence of privateKeyPath.

## 0.4.0 - 2017-05-17
### Configuration
* Add option `syncModel`.

### Command
* New command Upload.
* New command Download.
