## Common configuration

### name
A string to identify your configuration.

| Key | Value |
| --- | --- |
| *name* | *string* |

```json
{
  "name": "My Server"
}
```

### context
A path relative to the workspace root folder. <br>
Use this when you want to map a subfolder to the `remotePath`.

| Key | Value | Default |
| --- | --- | --- |
| *context* | *string* | *The workspace root.* |

```json
{
  "context": "/_subfolder_"
}
```

### protocol
Protocol to be used.

| Key | Value | Default |
| --- | --- | --- |
| *protocol* | `sftp` *or* `ftp` | `sftp` |

```json
{
  "protocol": "sftp"
}
```

### host
Hostname or IP address of the server.

| Key | Value |
| --- | --- |
| *host* | *string* |

```json
{
  "host": "server.example.com"
}
```

### port
Port number of the server.

| Key | Value |
| --- | --- |
| *port* | *integer* |

```json
{
  "port": 22
}
```

### username
Username for authentication.

| Key | Value |
| --- | --- |
| *username* | *string* |

```json
{
  "username": "user1"
}
```

### password
The password for password-based user authentication.

| ⚠️ Warning |
| :--- |
| *A string here is stored in `sftp.json` as plain text. If the file is in version control, so is your password.* | 

Set it to `true`, or leave it out entirely, and you are asked for the password once. It is then kept in the operating system's credential store — the Keychain on macOS, the Credential Manager on Windows, libsecret on Linux — and reused on the next connection. Nothing sensitive stays in `sftp.json`, so the file is safe to commit.

A stored password is saved only after the server accepts it, and dropped again if the server later rejects it, so a changed password re-prompts instead of failing forever. Use `SFTP: Forget Stored Password` from the command palette to remove one yourself, or set [passwordManager](#passwordmanager) to false to stop remembering it for a server.

| Key | Value | Default |
| --- | --- | --- |
| *password* | *string*\|*boolean* | |

```json
{
  "password": true
}
```

### passwordManager
Where the password lives.

| Value | Means |
| --- | --- |
| *true* | The OS credential store: the Keychain on macOS, VS Code's own storage elsewhere |
| *false* | Nowhere. You are asked on every connection, and anything already stored for this server is deleted |
| *"keychain"* | The macOS Keychain |
| *"vscode"* | VS Code's own secret storage, even on a Mac |
| *"secret-tool"* | libsecret, on Linux |
| *"1password"*, *"pass"*, *"gopass"*, *"bitwarden"* | That manager, read-only |

Leave it out and the `sftp.passwordManager` setting decides, which takes the same values and defaults to `true`. Set it per connection to override that.

`false` applies to that one credential, so a key passphrase can still be remembered while a password is not:

```json
{
  "passwordManager": false,
  "passphraseManager": true
}
```

Name only the manager and it looks for the item this extension would have created itself:

| Derived name | For |
| --- | --- |
| `vscode-sftp/sftp/deploy@example.com:22` | the password |
| `vscode-sftp-passphrase/home/me/.ssh/id_ed25519` | a key passphrase |

For `true`, `keychain`, `vscode` and `secret-tool` that is the service and account the extension already uses, so an entry it saved is found with no further setup. For the others, create the item under that name, or add a colon and point at one you already have:

```json
{
  "passwordManager": "1password:op://Private/My Server/password"
}
```

#### Moving a password out of this file
Set a manager next to a plain-text password and the password is moved there after the next successful connection:

```json
{
  "host": "example.com",
  "username": "deploy",
  "password": "hunter2",
  "passwordManager": "keychain"
}
```

becomes

```json
{
  "host": "example.com",
  "username": "deploy",
  "password": true,
  "passwordManager": "keychain"
}
```

`"passwordManager": true` does the same into the OS credential store. The move needs the manager written on the connection itself — the `sftp.passwordManager` setting says where credentials go, but is not on its own licence to edit your config file. A plain-text `passphrase` moves at the same time if `passphraseManager` is set. Other servers in the same file are left alone, including ones sharing a `profiles` block, because only values equal to the one actually stored are replaced.

| 💡 Note |
| :--- |
| *Nothing happens until a connection succeeds, so a password that doesn't work is never the one that gets saved. The file is rewritten only after the stored copy has been read back and matches — if the store refuses or returns something else, the file is left exactly as it was and the reason goes to the SFTP output channel. Losing the only copy of a password would be worse than leaving it in plain text a little longer.* | 

| ⚠️ Warning |
| :--- |
| *The read-only managers can't be written to, so a password sitting next to one of those is not moved; a warning says so and the file is untouched. Running a manager's CLI only happens in a [trusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust).* | 

| Key | Value | Default |
| --- | --- | --- |
| *passwordManager* | *string*\|*boolean* | `true` |

### passwordCommand
A shell command whose output is used as the password. Takes precedence over [passwordManager](#passwordmanager), and nothing is stored by this extension at all.

```json
{
  "passwordCommand": "security find-generic-password -w -s my-server"
}
```

```json
{
  "passwordCommand": "op read \"op://Private/my-server/password\""
}
```

| ⚠️ Warning |
| :--- |
| *The command comes from a file in your workspace, so running it runs workspace code. It only runs in a [trusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust), the same bar VS Code sets for tasks.* | 

| 💡 Note |
| :--- |
| *One trailing newline is stripped; everything else is used as-is, so a password may contain spaces. The command runs on every connection, so prefer one that doesn't prompt.* | 

| Key | Value |
| --- | --- |
| *passwordCommand* | *string* |

### passwordWriteCommand
A shell command that **saves** the password, reading it on standard input. The other half of [passwordCommand](#passwordcommand): without it a manager reached by command is read-only, so a password typed at a prompt is used once and lost.

```json
{
  "passwordCommand": "pass show servers/univers",
  "passwordWriteCommand": "pass insert -m servers/univers"
}
```

The secret arrives on **standard input**, never as an argument — an argument is visible to anything that can run `ps` for as long as the process lives. Write the command accordingly: `pass insert -m`, `gopass insert -f`, `secret-tool store …` all read from stdin. `op item edit … password=…` does not, and would put the secret in the process list.

Naming a write command means this credential lives there: nothing is written to the Keychain or to VS Code's storage as well, because two copies is two things to disagree later.

After writing, the secret is read back with `passwordCommand` and compared. `pass insert` and its kind report success on writing to the wrong path as readily as the right one, so a save that cannot be confirmed is written down as not having happened rather than assumed. With no `passwordCommand` to read back with, the log says it was not checked.

Output is discarded and never logged — several managers print the secret back on success.

| ⚠️ Warning |
| :--- |
| *The command comes from a file in your workspace, so running it runs workspace code, and this one is handed every password it saves. It only runs in a [trusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust).* |

| Key | Value |
| --- | --- |
| *passwordWriteCommand* | *string* |
| *passphraseWriteCommand* | *string* |

### hostVerification
Whether to check the server's SSH host key before sending anything. On by default; see [Host keys](./commands.md#host-keys) for what the three answers mean.

Set it to `false` for one connection that cannot be checked — a host behind a load balancer presenting different keys, say. `sftp.hostVerification` turns it off everywhere. `StrictHostKeyChecking no` in your ssh config does the same for that host, and `accept-new` takes a host nobody has seen before without asking while still refusing one whose key changed.

| Key | Value | Default |
| --- | --- | --- |
| *hostVerification* | *boolean* | *true* |

### knownHostsPath
Where this connection's `known_hosts` is, when it is not `~/.ssh/known_hosts`. Read in addition to this extension's own store, so trust you already have carries over.

Usually there is no reason to set it: `UserKnownHostsFile` in your ssh config is honoured and means the same thing.

| Key | Value |
| --- | --- |
| *knownHostsPath* | *string* |

### remotePath
The absolute path on the remote host.

| Key | Value | Default |
| --- | --- | --- |
| *remotePath* | *string* | `/` |

```json
{
  "remotePath": "/_subfolder_"
}
```

### filePerm
Set octal file permissions for new files.

| Key | Value | Default |
| --- | --- | --- |
| *filePerm* | *number* | `false` |

```json
{
  "filePerm": 644
}
```
 
### dirPerm
Set octal directory permissions for new directories.

| Key | Value | Default |
| --- | --- | --- |
| *dirPerm* | *number* | `false` |

```json
{
  "dirPerm": 750
}
```

### uploadOnSave
Upload on every save operation of VSCode.

| Key | Value | Default |
| --- | --- | --- |
| *uploadOnSave* | *boolean* | `false` |

```json
{
  "uploadOnSave": true
}
```

### useTempFile
Upload temp file on every save operation of VSCode to avoid breaking a webpage when a user accesses it while the file is still being uploaded (is incomplete).

| Key | Value | Default |
| --- | --- | --- |
| *useTempFile* | *boolean* | `false` |

```json
{
  "useTempFile": true
}
```

### openSsh
Enable atomic file uploads (*only supported by openSSH servers*).

| 💡 Important |
| :--- |
| *If set to* `true`*, the* `useTempFile` *option must also be set to* `true`.|

| Key | Value | Default |
| --- | --- | --- |
| *openSsh* | *boolean* | `false` |

```json
{
  "openSsh": true,
  "useTempFile": true
}
```

### downloadOnOpen
Download the file from the remote server whenever it is opened.

| Key | Value | Default |
| --- | --- | --- |
| *downloadOnOpen* | *boolean* | `false` |

```json
{
  "downloadOnOpen": true
}
```

### syncOption
Configure the behavior of the `Sync` command.

| Key | Value | Default |
| --- | --- | --- |
| *syncOption* | *object* | `{}` |

#### syncOption.delete
Delete extraneous files from destination directories.

| Key | Value |
| --- | --- |
| *syncOption.delete* | *boolean* |

#### syncOption.skipCreate
Skip creating new files on the destination.

| Key | Value |
| --- | --- |
| *syncOption.skipCreate* | *boolean* |

#### syncOption.ignoreExisting
Skip updating files that exist on the destination.

| Key | Value |
| --- | --- |
| *syncOption.ignoreExisting* | *boolean* |

#### syncOption.update
Update the destination only if a newer version is on the source filesystem.

| Key | Value |
| --- | --- |
| *syncOption.update* | *boolean* |

```json
{
  "syncOption": {
    "delete": true,
    "skipCreate": false,
    "ignoreExisting": false,
    "update": true
  },
}
```

### ignore
Ignore can be used to ignore files and folders from sync, and even supports wildcards using `*`. <br>
This is the same behavior as gitignore, all paths relative to context of the current configuration.
 
| Key | Value | Default |
| --- | --- | --- |
| *ignore* | *string[]* | `[]` |
 
```json
{
  "ignore": [
    "/.vscode",
    "/.git",
    "/.cache",
    "/_subfolder_",
    ".DS_Store",
    "*.gz",
    "*.log"
  ],
}
```

### ignoreFile
Absolute path to the ignore file or Relative path relative to the workspace root folder.
 
| Key | Value |
| --- | --- |
| *ignoreFile* | *string* |
 
```json
{
  "ignoreFile": "/.vscode/sftp.json"
}
```

### watcher
Configure the behavior of the `watcher` command.

| Key | Value | Default |
| --- | --- | --- |
| *watcher* | *object* | `{}` |

#### watcher.files
Glob patterns that are watched and when edited outside of the VSCode editor are processed.

| 💡 Important |
| :--- |
| *Set* `uploadOnSave` *to* `false` *when you watch everything.*| 

| Key | Value |
| --- | --- |
| *watcher.files* | *string* |
 
#### watcher.autoUpload
Upload when the file changed.

| Key | Value |
| --- | --- |
| *watcher.autoUpload* | *boolean* |

#### watcher.autoDelete
Delete when the file is removed.

| Key | Value |
| --- | --- |
| *watcher.autoDelete* | *boolean* |
```json
{
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": true
  },
}
```

### remoteTimeOffsetInHours
The number of hours difference between the local machine and the remote server (remote minus local).

| Key | Value | Default |
| --- | --- | --- |
| *remoteTimeOffsetInHours* | *number* | `0` |

```json
{
  "remoteTimeOffsetInHours": 3
}
```


| 💡 Note |
| :--- |
| *Leave it out on FTP and it is measured for you on the first listing. A `LIST` line carries no timezone — it is the server's wall clock — while `MDTM` returns the same moment in UTC, so comparing the two for one file gives the difference. Nothing is written to the server, and it costs one extra command per connection. The result is rounded to the nearest quarter hour and written to the SFTP output channel, and only believed if it is a timezone that exists — between −12:00 and +14:00 — because a listing older than a few months carries a date with no clock time, and measuring against its midnight produces an offset no timezone has. Setting this yourself turns the measurement off.* | 

| 💡 Note |
| :--- |
| *SFTP needs no offset: its timestamps are an absolute point in time, not a wall clock reading. A difference there means the server's clock is genuinely wrong, which this setting can still correct by hand.* | 

### remoteExplorer
Configure the behavior of the `remoteExplorer` command.

| Key | Value | Default |
| --- | --- | --- | 
| *remoteExplorer* | *object* | `{}` |
 
#### remoteExplorer.filesExclude
Configure that patterns for excluding files and folders. <br>
The Remote Explorer decides which files and folders to show or hide based on this setting. <br>
Setting this replaces the built-in defaults (`.git`, `.svn`, `.hg`, `CVS`, `.DS_Store`), so use an empty array to show everything.

| Key | Value |
| --- | --- |
| *remoteExplorer.filesExclude* | *string[]* |

#### remoteExplorer.order

| Key | Value |
| --- | --- |
| *remoteExplorer.order* | *number* |
```json
{
  "remoteExplorer": {
    "filesExclude": [],
    "order": 0
  }
}
```

### concurrency
Lowering the concurrency could get more stability because some clients/servers have some sort of configured/hard coded limit.

| Key | Value | Default |
| --- | --- | --- |
| *concurrency* | *number* | `4` |

```json
{
  "concurrency": 3
}
```

### connectTimeout
The maximum connection time.

| Key | Value | Default |
| --- | --- | --- |
| *connectTimeout* | *number* | `10000` |

```json
{
  "connectTimeout": 15000
}
```

### operationTimeout
How long (in milliseconds) any one operation may take before it is abandoned.

A command — a listing, a rename, a stat — must answer within this time. A
transfer is not given a deadline, because a large file on a slow line
legitimately takes as long as it takes; instead it must keep making progress,
and this is how long it may go completely silent before it is abandoned.

A connection that misses the deadline is closed rather than reused: nothing can
be sent down it again while a command is still stuck on it. The transfer is then
retried on a fresh connection, with the same verification as any other, so a file
still arrives whole or not at all.

Set it to `0` to wait forever, which is what happened before this setting existed.

| Key | Value | Default |
| --- | --- | --- |
| *operationTimeout* | *number* | `60000` |

```json
{
  "operationTimeout": 120000
}
```


| ℹ️ A timezone is not a clock |
| :--- |
| *That measurement sees a server's timezone, never a wrong clock: both readings come from the same clock, so an error in it cancels out. A clock that is simply wrong shows up separately — on a server without `MFMT`, a file this extension uploads keeps the server's own idea of the time, and the log then says how far out it is. That one is reported rather than corrected: a server minutes out of step is worth fixing where it is, and files uploaded from here carry your timestamp anyway.* |

### verifyTransfer
After each file is written, compare its size on the destination against the source and fail the file if they differ. <br>
On a transfer that uses a temp file the check runs before the temp file replaces the target, so a short transfer can never overwrite a good file.

| 💡 Note |
| :--- |
| *Costs one round trip per file. The check is skipped, not failed, when the server won't report a size — an FTP server without the `SIZE` command, for instance.* | 

| Key | Value | Default |
| --- | --- | --- |
| *verifyTransfer* | *boolean* | `true` |

```json
{
  "verifyTransfer": false
}
```

### limitOpenFilesOnRemote
Limit open file descriptors to the specific number in a remote server. <br>
Set to true for using default `limit(222)`.

| 💡 Important |
| :--- |
| *Do not set this unless you have to!* | 

| Key | Value | Default |
| --- | --- | --- |
| *limitOpenFilesOnRemote* | *mixed* | `false` |

```json
{
  "limitOpenFilesOnRemote": 15000
}
```
