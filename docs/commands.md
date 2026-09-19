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

You can change the default behavior by [syncOption](https://github.com/Natizyskunk/vscode-sftp/wiki/Configuration#syncoption).

### SFTP: Sync Remote -> Local
Same as `Sync Local -> Remote`, but in the opposite direction.

### SFTP: Sync Both Directions
Compare file modification times, and will always perform the action that causes the newest file to be present in both locations.

*Only [skipCreate](https://github.com/Natizyskunk/vscode-sftp/wiki/Configuration#syncoptionskipcreate) and [ignoreExisting](https://github.com/Natizyskunk/vscode-sftp/wiki/Configuration#syncoptionignoreexisting) are valid for this command.*

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

### Before a download replaces your file
Downloading a single file — with `Download File`, from the Remote Explorer, or through `downloadOnOpen` — first compares what is on disk against what is on the server.

If the local copy is **newer**, you are asked before it is replaced, with the two timestamps and the option to `Compare` them side by side first. If it is older, or missing, or identical, the download proceeds as it always did; the question only comes up when downloading would throw away work that exists nowhere else.

Timestamps are compared to the second, matching the sync algorithm, and a transfer copies the source's timestamp onto the target — so a file you downloaded and did not touch reads as identical, not as a conflict. A file changed within the same second is still treated as a conflict when its size differs.

`sftp.downloadWhenLocalIsNewer` controls this:

| Value | |
| --- | --- |
| *ask* | Ask first. The default. |
| *download* | Download without checking, how it behaved before. |
| *skip* | Keep the local file and note it in the SFTP output channel. |

`Download` in the [Alt menu](#alt-commands) always downloads, whatever this is set to.

### SFTP: Cancel All Transfers
Stop the current transfers (upload and download).

### SFTP: Open SSH in Terminal
Open a terminal in VSCode and auto login to a specific server.


## Alt commands
An alternative command can be found when pressing `Alt` while opening a menu.

### Force Download
Download file but disregard ignore rules.

### Force Upload
Upload file but disregard ignore rules.
