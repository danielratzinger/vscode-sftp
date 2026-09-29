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

### Passive mode behind NAT

Not a setting — but it is the most common reason an FTP connection feels slow for
no visible reason, so it is worth knowing what you are looking at.

A passive transfer starts with `PASV`, and the server answers with the address and
port to open the data connection to. A server behind NAT often answers with the
address it knows *itself* by:

```
> PASV
< 227 Entering Passive Mode (10,8,169,245,255,172)
```

`10.8.169.245` is private. Nothing outside that server's own network can reach
it, so a client that believes the answer waits for a connection that will never
be accepted, and only then tries the address it reached the server on. That wait
is `connectTimeout` — ten seconds by default — and it is paid **per data
connection**: once for every directory listed and every file transferred. Forty
directories is six and a half minutes of waiting, with the server answering every
command instantly in between.

So the answer is checked before it is used. An address in a range that only its
own network can reach — `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`,
`100.64/10`, or `0.0.0.0` — is replaced by the address the control connection is
already talking to. Two exceptions, both where the advertised address may be
telling the truth: the server is on your own network (the control connection is
private too), and the address is a public one that simply looks wrong. The
library's own timeout-and-retry stays behind this as the fallback for anything
that cannot be known in advance.

With `sftp.debug` on, a substitution says so:

```
[connection] PASV offered 10.8.169.245, which nothing outside the server's own
network can reach; using 185.15.44.2, where the control connection is
```

If a connection is still slow and you see no such line, the time is being spent
somewhere else — compare the timestamps around `PASV`, `LIST` and `RETR` in the
output panel and see which of them the gap sits next to.
