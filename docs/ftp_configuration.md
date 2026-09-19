## FTP(s) configuration

### secure
Set to true for both control and data connection encryption. <br>
Set to `control` for control encryption only, or `implicit` for implicitly encrypted control connection (this mode is deprecated in modern times, but usually uses port 990).

| Key | Value | Default |
| --- | --- | --- |
| *secure* | *mixed* | `false` |

```json
{
  "secure": control
}
```

### secureOptions
Additional options to be passed to `tls.connect()`.

| 💡 Note |
| :--- |
| *See [TLS connect options callback](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback).* | 

| Key | Value |
| --- | --- |
| *secureOptions* | *object* |

```json
{
  "secureOptions": {
    "enableTrace": true
  }
}
```

### showHiddenFiles
Ask the server for hidden files (dotfiles) by sending `LIST -a` instead of a bare `LIST`. <br>
Most FTP servers omit dotfiles from a bare `LIST`, which is why they don't show up in the Remote Explorer.

| 💡 Note |
| :--- |
| *When the server doesn't understand the flag, SFTP detects it and falls back to a plain `LIST` for the rest of the session, so you only need to set this to `false` if a server mishandles the flag without reporting an error.* | 

| Key | Value | Default |
| --- | --- | --- |
| *showHiddenFiles* | *boolean* | `true` |

```json
{
  "showHiddenFiles": false
}
```

### connectionLimit
How many FTP connections may be open at once. Since a connection carries one transfer at a time, this is also how many files transfer in parallel, and it replaces `concurrency` for FTP.

| ⚠️ Warning |
| :--- |
| *Servers cap how many connections they accept, and some treat a burst of them as abuse. SFTP grows the pool only while transfers are waiting and stops for good the first time the server refuses, falling back to the connections it already has — but if your host is strict, set this to `1`.* | 

| Key | Value | Default |
| --- | --- | --- |
| *connectionLimit* | *number* | `4` |

```json
{
  "connectionLimit": 2
}
```
