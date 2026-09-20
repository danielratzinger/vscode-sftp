# MCP server — design note

**Status: proposed, not built.** A record of what has been decided and why, so the
build can start from a settled shape rather than re-litigating it.

The goal: let a local MCP client (Claude Desktop first) search and read the code
on servers this extension is already connected to, without mirroring whole trees
by hand.

---

## Decisions

| Question | Decision |
| --- | --- |
| Where does the server live | In the extension host, not a standalone process |
| Lifetime | Running whenever VS Code is, gated by a setting |
| Transport | JSON-RPC over HTTP POST on loopback, plus a stdio bridge |
| Multiple windows | One leader binds the port and aggregates the others |
| Which connections | Exactly those in the SFTP explorer, filtered by exposure |
| Cache | On demand, driven by the tools, in extension storage |
| Access | Read-only for now; write is expected later and the design allows it |
| Primary client | Claude Desktop. ChatGPT is possible but constrained — see below |

---

## Why in-extension

A standalone process would have to re-implement connections, the config format
and credential handling. In the extension host, `getAllFileService()`,
`RemoteFileSystem`, the FTP connection pool and the credential store are all
already there. The cost is that the server lives and dies with VS Code, which is
what was wanted.

## Transport

`initialize`, `ping`, `tools/list`, `tools/call`, plus swallowing notifications
with a 202 and handling JSON-RPC batches. Nothing else is needed, because the
server never initiates a message to the client.

That means **no SSE, no stream management, no server-held session state**, and
`GET`/`DELETE` answer 405 — which the spec permits for a server that initiates
nothing. A few hundred lines in the extension host; no MCP SDK dependency to
bundle.

Claude Desktop and several other clients speak stdio only, so a small bridge
binary (spawned by the client, forwarding to the loopback endpoint) ships
alongside. The bridge is the compatibility layer; the server stays one thing.

### Staying put across restarts

A client's configuration must survive reboots without editing, and for the stdio
clients it does so by construction: **their config holds a command, not a URL.**
Claude Desktop spawns the bridge; the bridge finds the server. The port never
appears in anything the user maintains.

The bridge discovers it through a small file in the user's home directory,
written by whichever window is leader and holding the port and the session
token, mode 0600. On a restart the extension activates, the leader rebinds, the
file is rewritten, and the next bridge spawn picks it up. Nothing to re-pair.

Putting the token in that file is deliberate. It defends what a token can
actually defend against here — a web page reaching loopback via DNS rebinding,
which cannot read files — while a process already running as the user could read
the file, and could equally read the SSH keys next to it. Pretending otherwise
would be theatre.

A stale file (VS Code crashed, port now dead) is the bridge's problem to detect:
it verifies before forwarding and exits with *"VS Code is not running with the
SFTP extension enabled"* rather than hanging.

For clients that take a URL directly, `sftp.mcp.port` is a fixed configurable
number so the URL is stable too. A collision is reported clearly and changed
once.

### Setting a client up

Settings hold the knobs — `enabled`, `port`, `exposed`, `materialize`. They are
the wrong place for the connection details, because a setting description is
static markdown and cannot show a real path or a real token.

Those come from a command, `SFTP: Show MCP Connection Details`, opening a panel
with the exact snippet and a copy button, plus a status bar item showing the
server is listening and which window is leader. An optional action writes the
entry into a detected client's config after showing what it will change.

There is very little to show, because the bridge resolves the port and token
itself:

```json
{ "mcpServers": { "sftp": { "command": "node", "args": ["…/bridge.js"] } } }
```

No secret, no port, nothing that goes stale. Paste once.

**The bridge must not live inside the extension directory.** VS Code versions
those folders — `anthropic.claude-code-2.1.274-darwin-arm64` is what one looks
like — so a path into ours would break on every update, silently, and the user
would discover it when their agent stopped seeing any servers. It is installed
next to the discovery file at a stable path and refreshed on activation.

The same rule covers anything else a user is asked to paste: it may not contain
a value this extension versions.

### ChatGPT

ChatGPT cannot reach a loopback server, desktop app or web. Its MCP apps are
connectors called from OpenAI's backend: you supply an endpoint URL, it scans the
tools. The only sanctioned route to a private server is OpenAI's Secure MCP
Tunnel — `tunnel-client` running locally, holding an outbound connection to
`api.openai.com` and forwarding requests inward. That also requires developer
mode, which is documented for Business/Enterprise/Edu on ChatGPT web.

Consequence: serving ChatGPT means remote file contents transit OpenAI. It is
supported-but-documented, never automated, and it is not the design target.

## Multiple windows: leader aggregation

Each window is a separate extension host. One elects itself leader, binds the
port, and aggregates connections from the others over IPC; the rest stand down.
A status bar item shows which window is serving and how many connections.

The leader also owns any persisted state, so windows never race on it.

## Which connections are visible

The SFTP explorer's root list *is* `getAllFileService()` — one root per
`.vscode/sftp.json` per workspace folder, already covering multi-root workspaces.
No registry, no discovery scan, no central file: what is in the sidebar is what
the server can reach, and closing the window removes it.

Exposure is two levels, mirroring how `passwordManager` works:

```jsonc
// VS Code settings
"sftp.mcp.enabled": false,   // binds the port at all — the real boundary
"sftp.mcp.exposed": true     // default for connections that don't say

// .vscode/sftp.json
{ "host": "example.com", "mcp": { "exposed": false } }
```

Per-connection wins; the setting fills in. `mcp` is a nested object like
`remoteExplorer` and `syncOption`, leaving room for `readOnly`, `redactSecrets`
and `rootPath` later without new top-level keys.

**Profiles get this for free.** A root resolves the *active* profile, so
`mcp: { exposed: false }` inside a production profile makes the connection
disappear from the tool list when that profile is selected, rather than the same
handle quietly retargeting to a different machine.

`exposed: false` hides a connection from MCP only. It still loads, still appears
in the explorer, still syncs on save.

## What happens on first use

Once the server is enabled and a client has paired with it, read tools work with
no further prompting from us. Two things about that are worth stating, because
the obvious implementation of each is wrong.

**An MCP-originated call never raises an interactive prompt.** A connection set
to `password: true` with nothing stored yet would otherwise pop a password box in
VS Code while the user sits in another application watching a tool call hang,
possibly without that window even focused. Instead the call fails with something
the agent can relay:

> No stored credentials for `deploy@example.com`. Connect once in VS Code first.

Deliberate, legible, and it keeps the first connection to a server something the
user does knowingly. The same rule covers every other modal the transfer path can
raise — host key confirmation, the newer-local-file question, anything added
later.

**Exposure is evaluated live, not at connect time.** Editing `sftp.json`,
switching profile, or closing a window changes which connections answer. The tool
*list* does not change, since connections are arguments rather than tools, but a
handle a client obtained earlier can stop resolving. It must then fail as
`Unknown server` — the same wording as one that was never exposed, so absence
and withdrawal are indistinguishable from outside.

Note also that the client has its own permission layer. Claude Desktop asks the
user to approve tools before calling them; that is on top of anything here, and
is not something this server can or should try to influence.

## Where files live

**The project directory is the primary copy.** The cache holds only files whose
local copy disagrees with the server, which keeps it small and makes its
lifetime easy to reason about.

Resolution per file, using `compareLocalWithRemote`:

| Local state | Where it goes |
| --- | --- |
| Missing | **Workspace** — nothing to lose, and it becomes your working copy |
| Identical | **Workspace** — already correct, no write at all |
| Local is newer | **Cache** — your edits untouched, divergence reported |
| Local is older | **Cache** — divergence reported, you decide whether to take it |

The invariant: **the MCP server never changes a file you already have.** It only
materialises what is absent. A differing file — in either direction — goes to the
cache and is reported, rather than being silently overwritten.

`older` is deliberately included. The alternative is that an agent's search
quietly rewrites a file in your working tree because the server moved on, which
is recoverable from git but is a change you did not make and might commit by
accident. Reporting it and letting `Download File` (which already prompts) take
it is the better workflow. `mcp: { materialize: "not-newer" }` opts into the
looser behaviour.

### The remote listing is the authority for what exists

Two separate things, and conflating them is the easiest way to get this wrong:

- **The index** — what files exist, where, how big, when changed. This comes
  from the remote `LIST`/`readdir` manifest. **Always.**
- **The content store** — where the bytes are read from: workspace, or cache
  when the copies disagree.

Every enumeration is built from the index: directory listings, the file tree,
`find`-by-path-pattern, and the set of files a search scans. **Nothing is ever
enumerated by walking the workspace**, however convenient that would be.

Walking the workspace would be fast and completely wrong. It would miss server
files that were never materialised, and it would invent files that are not
deployed at all — `.git`, `node_modules`, build output, local scratch files,
work in progress. An agent asking what is on the server would get an answer
describing your laptop.

A file present locally but absent from the remote manifest is **local-only**:
`stat` reports it as such, and it appears in no listing, no tree and no
search result, because it is not on the server.

### Reading

Every read checks the cache first:

- **In the cache** → serve that content, which is the server's, and tell the
  client the local copy differs, with both timestamps.
- **Not in the cache** → serve the workspace file, which by construction equals
  the server's.

So **remote content is always the default**. The agent asked what is on the
server; that is what it gets, consistently, whether or not a local copy exists.
The same rule governs the search index — searching must not match your
uncommitted edits and report them as what is deployed.

The working copy is reachable only through a separate, explicitly named tool
(`local-copy`). A named tool rather than a `version` argument, because an
argument is easy for a model to omit by accident and the distinction matters.

### Invalidation

A cache entry exists to record a disagreement, so it is purged the moment the
disagreement ends:

- **After a successful download** — the local copy now *is* the server's copy,
  and because a transfer copies the source's mtime onto the target, it compares
  as identical.
- **After a successful upload** — same reasoning in the other direction.

The hook is `fileService.afterTransfer()`, which already fires for every
`TransferTask` with its direction and local path. One subscription covers
Download File, Download Folder, Download Scripts and both sync directions
without touching any of them.

A cache entry is also keyed by the remote `(mtime, size)` it was fetched at, so a
file that changes again on the server is re-fetched rather than served stale.

### Freshness

Per **directory**, not per file — one `LIST` returns mtime and size for every
entry, so a refresh is:

1. list the directories in scope (parallel across the FTP connection pool),
2. diff against the manifest on `(mtime, size)`,
3. act only on what changed.

**Known limit:** FTP `LIST` often has minute precision and no seconds, so a file
edited within the same minute to the same size is invisible to the diff. Tools
take a `force` argument and say so in their descriptions. SFTP has real
second-resolution mtimes and is unaffected.

### Materialising into the workspace fights the watcher

`watcher.autoUpload` uses a `vscode.FileSystemWatcher`, so *any* write into the
workspace fires it — including ours. `fileWatcher.ts` already guards against
this by skipping files with a download task still in flight, but the upload is
debounced by 550ms and a small materialisation finishes in milliseconds: the
task deregisters, the guard sees nothing, and the file is uploaded straight back
to the server, rewriting its mtime.

Materialisation must therefore go through the normal `TransferTask` path *and*
register the path in a short-lived "just written" set the watcher consults. That
also closes the existing race for ordinary fast downloads.

## Search

Search **runs locally, over the file set the remote manifest defines**. The
manifest says which files exist; their content is read from the workspace, or
from the cache where the two disagree — so a search always reflects what is
deployed, never your uncommitted edits.

That means searching a subtree first requires its content locally. The cost is
real and belongs in the tool description: scoping with a directory is
dramatically cheaper than the whole server, the first search over a subtree
downloads it, and every search after that re-fetches only what the manifest diff
says changed.

### What v1 does

Two cheap, exact mechanisms, fused:

- **Content** — literal or regex, case-insensitive, with a context window either
  side of each hit and a per-file cap so one file cannot crowd out the rest.
- **Path and filename** — substring and glob over the manifest, which is often
  what "where is the user model" actually means.

Ranking by match count, path proximity and filename hits. No index to build, no
state to invalidate beyond the manifest we already keep.

### Relevance ranking, when a model is available

`vscode.lm.selectChatModels()` is stable API and returns whatever chat model the
user already has. When one is there, a semantic-ish `mode` becomes available:
generate candidates with the cheap mechanisms above (tens to low hundreds of
files), then ask the model to rank them against the query. That answers "where do
we validate the session" when the word *session* appears nowhere.

**When no model is available, the mode is simply not offered** and search falls
back to content and path matching. No configuration, no degraded half-feature.

MCP **sampling** (`sampling/createMessage`, asking the client's own model) is the
secondary route, since the client is usually a capable coding model itself. It is
not the primary one: support is uneven across clients and several require
per-call approval, which is poor for interactive search.

Note that reranking sends candidate snippets to a model, so redaction must
already have happened — see below.

### Why there is no embedding index

Considered and rejected for v1, after checking what is actually available:

- **VS Code has no embeddings API.** The current typings (1.138) contain no
  occurrence of "embedding". Stable `vscode.lm` offers `selectChatModels`,
  `registerTool`, `invokeTool` and `registerMcpServerDefinitionProvider` — chat
  and tools, nothing vector-shaped.
- **The installed assistant extensions expose nothing callable.**
  `anthropic.claude-code` declares no `api` and no relevant contribution;
  `openai.chatgpt` uses the *proposed* `languageModelProxy`, which is allow-listed
  to its publisher. Either would mean poking undocumented `.exports` on
  extensions that ship frequent versioned builds.
- **Running our own** means an embedding provider, a vector store, a chunking
  strategy, and invalidation — and with a remote provider, shipping the whole
  codebase to a third party in bulk, which is a much larger step than answering
  one question about one file.
- **The client is already good at this.** Claude Desktop does retrieval well
  given decent tools; that is how Claude Code works on local repositories, with
  no embeddings at all. What only this server can provide is exact search,
  structure and freshness *over the remote*. Choosing which file matters is the
  model's job.

If reranking proves insufficient in practice, an embedding index is the
escalation — with the manifest diff as its incremental-update primitive, since
that already names exactly which files changed.

## Annotation index

A short description per file — *"verifies Stripe webhooks and fulfils orders"* —
plus a per-connection overview of how the thing is built.

This is the orientation layer, and it is worth more to an agent than similarity
search was. A tree of eight hundred filenames is weak signal; the same tree with
one line of purpose each lets a model choose what to read without reading
anything. Unlike vectors, the annotations are **text**: inspectable by a human,
searchable by the existing content search, and obviously wrong when they are
wrong.

It attaches to the manifest, so it needs no invalidation machinery of its own.

### Populating it

Three routes, in the order worth building them:

1. **The client writes back what it learns.** An agent reads a file to answer a
   question, understands it, and calls `note(path, summary)`. The index
   accumulates as a side effect of work already happening — no batch cost, no
   separate model call — and it persists, so the next session starts oriented.
   This is a write to our local index, never to the server, so it stays inside
   the boundary drawn elsewhere in this note.
2. **`vscode.lm` when a model is available**, on the same availability rule as
   reranking: present, so offer it; absent, so do not.
3. **MCP sampling.** A far better fit here than for search: summarising is a
   batch background job, so latency does not matter and one approval can cover a
   run rather than every query.

### The overview: facts before prose

Most of what is wanted is deterministic and cheap — framework and version from
`composer.json` / `package.json` / `wp-includes/version.php`, entry points,
routing and config locations, directory conventions, counts by file type. That
layer costs nothing, is always available, and cannot hallucinate.

A model-written narrative sits on top, optional, labelled as derived, and citing
the files it was inferred from. A model confidently asserting the wrong queue
driver is worse than silence.

### Notes on the connection itself

The same idea one level up: not just what each file does, but **what the project
is**. *"Company website for XY GmbH — WordPress 6.4, custom theme, Contact Form 7."*

Much of it is deterministic, from files the manifest already lists:

- `composer.json` / `package.json` — name and description
- the first heading of a `README`
- a theme's `style.css` header, which carries Theme Name and Author
- `config/app.php`, or an equivalent framework config, for the application name
- an imprint or contact page, which on a German site names the company outright
- the connection's own host and remote path

A model turns those into a sentence when one is available; without one, the raw
facts are still worth returning.

This belongs in `servers()`, not only in `overview()`. An agent
choosing between five connections should see *"XY GmbH company website
(WordPress)"* rather than five hostnames — the same orientation problem as the
annotated tree, one level up, and the point at which a wrong guess is most
expensive.

### Staleness and pruning

A note describes one version of a file. **A confidently wrong summary is worse
than no summary**, so notes get the same discipline as cache entries.

Keyed by `(path, mtime, size)`, exactly like a cache entry. A file that moves on
does not silently keep its old description: the note is marked **stale**, carries
the version it described, and is never served as current. It is kept rather than
dropped, because a small edit rarely changes what a file is *for*, and a stale
note is cheap to refresh and useful as a starting point.

Unlike cache entries, notes are **not** purged by a transfer. A cache entry
records a disagreement and is meaningless once the copies agree; a note records
understanding, which a download does not invalidate. Only a content change does,
and the key already captures that — no `afterTransfer` hook needed.

Pruned when:

- **The path leaves the manifest.** The server no longer has that file, so the
  note describes nothing. Deleted on the refresh that notices.
- **It has been stale too long** — past an age or a number of intervening
  versions. A description that has been wrong for months is not a starting point.
- **Its connection is gone.** Config deleted, orphaned notes go with it — the
  connection's own note included. Un-exposing a connection does *not* prune:
  that is temporary, and discarding accumulated knowledge over it would be rude.
- **The files a connection note was derived from changed.** It is keyed by those
  files' versions, like any other note, and goes stale rather than silently
  describing a project that has moved on.
- **The store exceeds its cap**, evicting least-recently-used, as a backstop.

`forget(server, path?)` drops notes deliberately, and the same pruning pass
removes manifest entries for paths that no longer exist — one sweep, one set of
rules, so the two stores cannot drift apart.

## Tool surface

Names and shapes are the part users live with longest.

| Tool | Purpose |
| --- | --- |
| `servers` | The exposed connections: id, project, host, remote path, active profile, and what each one *is* where known |
| `search` | Content and path search over the remote file set; path, line, snippet. `rank: "model"` when one is available |
| `read` | One file or line range — **always the server's content**, refreshed if stale |
| `local-copy` | The working copy, when it differs. Explicit by design |
| `list` | A live directory listing, from the remote manifest |
| `tree` | Remote structure to a given depth, annotated with each file's purpose where known. The first call an agent should make |
| `stat` | One path's state: same, diverged, local-only, with both timestamps |
| `sync` | Explicit refresh of a subtree, reporting what changed |
| `overview` | How the project is built: detected facts, plus a derived narrative when available |
| `note` | Record what a file is for. Writes the local index, never the server |
| `forget` | Drop notes for a path or a whole connection |
| *(later)* `write` | Gated behind write scope and per-operation confirmation |

`search` and `fetch` additionally carry OpenAI's compatibility shape
(`{results: [{id, title, url}]}` and `{id, title, text, url, metadata}` as
`structuredContent` plus a JSON copy in `content`), which costs nothing and keeps
the tunnel route open. A `url` of `sftp://user@host/path` makes results citable.

Conventions, all borrowed from a working implementation (see below):

- Every result says what it refreshed: *"2 files updated, 118 from cache."*
- Paginated replies state how many remain and what offset to pass next.
- Descriptions carry cost hints — which argument narrows the work, what the
  default limit is, when to raise it.
- `initialize` returns an `instructions` string that sets the workflow before any
  tool is chosen: check freshness before syncing, search before fetching, scope
  with a directory.

## The third version of a file

Every tool here answers with one of two versions: what the server has, and what
is on disk. The question an agent most often needs answered is between them -
*how did the working copy get like this?* - and the only record of that is the
editor's own local history.

There is no API for reading it. The Timeline is a provider interface, not a
reader, so `history` reads VS Code's store on disk: `User/History/<hash of
the file URI>/entries.json`, with each version's content beside it. The store
is VS Code's, so it is only ever read.

Three things make that safe to depend on rather than reckless:

- **The location is derived, not guessed.** `globalStorageUri` sits two levels
  below `User`, so `History` is found without knowing anything about the
  platform, the build, or a portable install.
- **The folder name is an optimisation, not the lookup.** VS Code names each
  folder `hash(uri).toString(16)`, which turns a lookup into one read instead
  of a scan of every file ever edited - but the `resource` inside is the proof,
  and a mismatch falls back to a scan. If the naming scheme changes, this costs
  a scan rather than the feature. If the *format* changes, the `version` field
  says so and the tool reports no history rather than guessing.
- **It is held to the same rules as everything else.** Path containment,
  denied files, size limits, redaction. An earlier version of `.env` is just as
  much a credential as the current one.

`diff` then compares any two of the three - or of four, since a side can
name another connection (`server:<id>`). Two servers hosting one project mount
it at different roots, so the counterpart is the same path *below* the root
rather than the same absolute path, and resolving it through the other
connection's root means the boundary is checked again on that side: a path that
is inside one connection has no standing in another. A connection that is not
exposed answers “Unknown server.”, the same words as one that does not exist. Both sides are redacted before
they are compared, which means a credential that *changed* becomes the same
marker on both sides and shows as no change at all. That is the safe direction,
but silently wrong to a reader, so the diff says when it applies.

The diff itself is ours rather than a dependency: common prefixes and suffixes
are trimmed, the middle is compared exactly, and anything still too large after
that is summarised rather than left to run. A summary is worth more than a tool
that stops responding.

## Secret redaction

Pointing an agent at a production document root means `.env`, `wp-config.php`,
`.htpasswd` and stray private keys. Three layers, most reliable first:

1. **Never serve a deny-list of filenames** — `.env*`, `wp-config.php`, `*.pem`,
   `id_rsa*`, `.netrc`, `.git-credentials`, `.htpasswd`. Return a stub so the
   model knows the file exists and stops looking. Highest precision: these files
   are entirely secret. Enforced at cache-write time so they never land on disk.
2. **Redact high-confidence token patterns** in what is served — `AKIA…`,
   `ghp_`/`github_pat_`, `sk_live_`, `xox[baprs]-`, `AIza…`, `SG.`, PEM blocks,
   JWTs. A few dozen hand-written rules, auditable and ours to maintain.
3. **Redact named assignments, judged on the right-hand side** — the bespoke
   secrets, which are most of them: `define('DB_PASSWORD', '…')`, `$cfg['pw'] =
   '…'`, `password: '…'` in YAML. A name alone is a bad rule — it eats
   `$_POST['password']`, `env('DB_PASSWORD')`, `'password' => 'required|min:8'`
   and every field list in the codebase — so what separates a credential from a
   reference to one is the *shape of the value*: a quoted literal with content in
   it, not an interpolation, a template, a URL, a mask or a placeholder.
   `define()` gets its own rule rather than adding `,` to the general one, which
   would have eaten `compact('password', 'email')`. Off with
   `sftp.mcp.redactAssignments: false`; on by default, because a missed
   credential is worse than a redacted validation rule.

   The names are not only English. Code written by German speakers calls the
   field `$kennwort` or `$passwort`, and an English-only rule reads straight
   past a hardcoded credential in half the code it is pointed at, so the list
   covers the common European spellings.

   The same rule runs **without quotes** for `PASSWORD=...`, `password: ...`
   and `X-Password: ...`, where a Dockerfile, a YAML file, an ini file or a
   captured header keeps its secrets. An unquoted value has nothing proving it
   is a value at all, so it has to earn it: no expression punctuation, not an
   identifier chain like `process.env.API_KEY`, and at least one digit or
   symbol. That last rule is what spares `{ password: hashedPassword }`, which
   is a reference and common in JavaScript, at the cost of missing
   `PASSWORD=supersecret`. That is the right way round for a rule that cannot
   see quotes.

   Two shapes carry a credential with no name in front of it at all, and are
   matched directly: a connection string with its own password
   (`mysql://root:...@host`) and an `Authorization: Bearer ...` token, the
   latter shaped tightly enough to leave `'Bearer ' . $token` alone.

   High-entropy strings are still *not* redacted: hashes, ids and minified code
   look identical to keys, and a redaction that eats real code makes the model
   hallucinate around the hole.

**Only the text handed to a client is redacted. What is written to disk is the
server's bytes, verbatim.** The copy in the project directory is the one the
user keeps editing and uploading by hand, so a marker in it would blank a live
credential on their next save. `materialise` writes the bytes it fetched and
nothing else; redaction happens afterwards, on a string, on the way out. Three
tests hold that line: after a fetch, after a search, and on a local copy that is
newer than the server's.

**Markers are numbered and reversible**: `[redacted:assigned-secret:2]`, one per
value, and `redact` returns what each stands for. `restoreFrom(text, original)`
puts them back by redacting the untouched local copy at the moment it is needed
— so the plaintext stays in the one place it already was, no vault of secrets
is written anywhere, and a file that changed underneath yields `unresolved`
rather than a wrong guess. There is no write path yet; this is what one would
have to call before uploading text an agent edited, and why `canReturnWhole`
could eventually relax.

The note that accompanies a redaction is written against a specific failure:
not leakage, but invention. A model that meets an unexplained marker treats it
as a bug, works out what belongs there, and writes its own value over a real
one. So the note says the values are unchanged on the server and in the local
copy, that nothing in the task depends on knowing them, and that each marker is
to be left exactly as it stands.

Redact **before anything reads the text**, not just on fetch: otherwise a search
for `AKIA` confirms a secret exists and the snippet leaks it while `fetch`
dutifully hides it, and a reranking pass hands the raw snippet to a model. The
scrubbed text must be the only text the server ever holds.

**A redacted file can never be returned whole.** The marker is evidence that the
original is not here, and handing back a "complete" copy invites someone — or an
agent, once write lands — to save it over live credentials. Refuse, and say why.

### Taken from PostRequest

Its client redacts what it sends to a server, so its rules have met production
traffic and its tests record what that cost. Four things came back here:

- **Names in other languages.** Its password pattern carries a dozen
  translations. An English-only rule is half a rule in a codebase written by
  people who do not work in English.
- **Key position, not value shape.** Its rule once read
  `input[type="password"]:focus{...}` as key `password`, separator `:`, value
  `focus{...}`, and a stylesheet came back through code search with its
  selector replaced by a marker - silently, since a marker looks exactly like a
  redaction that was meant to happen. Our requirement that a quoted value be a
  quoted *literal* already refused every one of those shapes, which its tests
  confirmed when run against this code; the `(?<![=.#])` guard is now here too,
  because the unquoted rule has no quoting to lean on.
- **Unquoted values, the ones we were missing.** Running its test cases here
  showed `PASSWORD=...`, `password: ...` and `X-Password: ...` passing through
  untouched, along with connection strings and bearer tokens.
- **Never keep a reversible copy.** Its first redaction manifest recorded the
  original values; the v2 generation exists to carry none, and its packager
  deletes pre-v2 manifests rather than ship them. Here the originals exist only
  in memory, only to put a file back together during a write, and only from the
  copy already on this machine - a test asserts they never reach a tool result.

One rule was deliberately **not** taken: it redacts hex strings of 40
characters or more. In source code that is a git SHA far more often than it is
a secret.

Redaction is a seatbelt, not the brakes. You cannot enumerate every secret
shape — a credential built by concatenation, or read from a database, passes
every rule here. The real control is not exposing the connection.

## Limits, and why each one exists

Every bound is there because something unbounded has an owner who pays for it.

- **2 MB per file** (`sftp.mcp.maxFileBytes`), checked against the remote size
  *before* the fetch, and applied to search too. Source files are kilobytes;
  what trips this is a log, a dump or a video, none of which read as text.
- **Not text, not served.** A NUL byte in the first 8 KB means the answer would
  be pages of replacement characters. The file stays on disk, where something
  that can read it may.
- **1000 entries per listing**, saying how many were left out. A directory of
  ten thousand uploads is not a listing anyone reads.
- **2000 files, 8 levels per walk**, already there, with the same reasoning.
- **Pruning is wired to the tree walk**, where a complete picture of the server
  exists: notes for files that are gone, and now the cached bytes too. Both are
  skipped when the walk was truncated, because a partial walk looks exactly
  like a server that lost most of its files.
- **Nothing waits forever** (`operationTimeout`, 60s). A command must answer
  within it; a transfer is watched for silence instead, because a large file on
  a slow line legitimately takes as long as it takes. An FTP connection that
  misses it is destroyed rather than reused - a stuck command cannot be
  followed by anything, not even `QUIT` - which turns a stall into a dropped
  connection, the one failure everything above already recovers from.
- **Every limit has a way past it.** A limit that only says "ask something
  smaller" is a dead end when there is nothing smaller to ask: a flat directory
  of ten thousand uploads has no subdirectory to narrow to. So `list`,
  `tree` and `search` take an `offset` and return a `nextOffset`,
  and `read` already took line ranges. The budget running out is itself
  a resume point now, rather than only an apology.

  Paging is only worth offering if page two is cheaper than page one, so a walk
  is remembered for two minutes and a continuation reads from it. The first
  page is always walked fresh - what a listing says is what the server has now
  - and only continuations come from the cache, which is also what makes the
  pages consistent with each other rather than a mixture of two moments.
- **A ceiling on the call, not only on the operation** (`sftp.mcp.callTimeout`,
  120s). Every operation is bounded, but a call is many operations: a search
  walks directories and reads files, and the worst case is many bounded waits
  in a row. The tools that loop check the budget between round trips and stop
  early, returning what they found and saying it was cut short - a partial
  answer is worth more than a failure, and it tells the model to narrow the
  question. The dispatcher stops anything that does not check, so no tool can
  run past the budget however it is written.
- **One transfer at a time per file.** Clients call tools in parallel; two
  calls wanting the same file would write it twice while reading it once, and
  the reader can catch it half-written. Queueing by `connection:path` also
  makes the second caller find the file already correct, so it costs one round
  trip rather than two.

## Security model

- **Loopback only**, never `0.0.0.0`.
- **Per-session token**, plus `Origin`/`Host` validation against DNS rebinding.
- **Read-only with respect to the remote** — it never writes to your servers.
  It does write to disk, and sometimes into your project, so "read-only" must
  never be the unqualified wording in docs or setting descriptions.
  `mcp: { materialize: false }` gives a genuinely side-effect-free reader.
- The token carries scopes from day one so adding write is not a retrofit.
- **Write, when it arrives**, needs per-operation confirmation in VS Code and an
  audit trail — an agent silently writing to production over a loopback port is
  the failure mode to design against before it is possible.
- **A hidden connection reports "unknown", not "forbidden"** — refusing by
  pretending absence avoids confirming that something is there.
- **No interactive prompt is ever raised by an MCP call.** Missing credentials,
  host key confirmation and transfer questions all fail with a message the agent
  can relay, rather than a modal in a window nobody is looking at.
- **One exposure check**, resolved once and applied to every tool, rather than
  repeated per tool where one will eventually be forgotten.
- **The connection's `remotePath` is a boundary, not a starting point.** Every
  path argument is resolved against it and refused if it lands outside, because
  a path decides two things at once: what is read from the server, and where it
  is written on this machine. Unchecked, `/srv/app/../../etc/passwd` reads a
  part of the server nobody exposed *and* materialises it outside the project
  folder, anywhere the user can write. That is the whole of `mcp.exposed`
  undone by a string, and it is reachable by an agent following instructions it
  read in a file on that server. Resolution is canonical, so one file also has
  one cache path and one note key however it was spelled; `cachePathFor` drops
  `..` segments as well, being the last step before a write.
- **Refusal says the same thing for a real path and an imagined one**, so it
  cannot be used to map what is there.
- **Audit every `tools/call`** to the output channel: tool, connection, outcome.
  When this reaches production servers, "what did the agent actually read?" needs
  an answer.

## Lessons taken from PostRequest's MCP server

`dashboard/mcp.php` in the postrequest.com repo is a working, in-production
implementation. What was adopted:

- **POST-only, no SSE** — the realisation that a server which initiates nothing
  needs none of the streaming machinery. This is why no SDK is required.
- **UTF-8 sanitation of every tool result.** Source files are not obliged to be
  UTF-8, and a single latin-1 byte makes the whole JSON envelope fail to encode.
  What the user then sees is a transport error naming no tool, no path and no
  server. Substitute the bad bytes; losing one line beats losing the call.
  Especially relevant here — legacy PHP on shared hosting is exactly this case.
- **Refuse, never truncate, a whole-file read.** Half a file looks exactly like a
  complete one until it is saved. The refusal states the size and points at the
  range-based tool instead.
- **Redacted files cannot be handed back whole** (see above) — a rule that only
  becomes obvious after thinking about who saves the result.
- **`instructions` on initialize as a workflow primer**, because the common
  failure is the model reaching for the expensive tool first.
- **Descriptions carrying cost hints**, and pagination that states its own
  continuation.
- **A companion tool for what display truncation removed** — their `read_chars`
  recovers the middle of an elided long line. Truncate for readability, but
  always ship the exact escape hatch.
- **Session id for audit grouping only**, granting nothing, and deliberately
  *not* 404-ing an unrecognised one, which would send a client that merely
  garbled a header into a re-initialize loop.
- **Lazy bootstrap** — the handshake must not pay for connecting to anything.

A second pass, once this was built, found four more:

- **`outputSchema`, not just `structuredContent`.** Every tool here returned
  structured data and none of them declared its shape. A client that validates
  it had been told nothing. Declared now for the four tools whose structure a
  caller would actually key on, and deliberately absent from the ones that
  return prose: a shape advertised for prose is worse than none.
- **`openWorldHint` was false on every tool, and that was untrue.** It is how a
  client decides whether a call leaves the building, and half of these reach a
  production server. Now true for the tools that do and false for the ones that
  only touch this machine — which is also the more useful reading of the
  distinction than "does it mutate".
- **“What changed” is a different question from “what exists”**, and a much
  cheaper one. Their playbook puts it plainly: when something worked until
  recently, what the last deploy touched is often the whole of the answer
  rather than a hint towards it. `tree` takes `since` (“7d”, “48h”, a
  date) and `sort`, reusing the walk, the manifest cache and the paging that
  were already there — no new tool, because the walk already carried the times
  that answer it.
- **Descriptions are where a model decides what to reach for**, so the cost
  hints belong in them rather than in a design document. `stat` now says
  what it is for: size and modification time without transferring anything, so
  a range can be chosen deliberately instead of pulling a megabyte to find out
  it was a megabyte.

Not adopted: bearer tokens with RFC 9728 discovery and per-token rate limits.
Those are built for a public HTTPS endpoint; on loopback a session token and
origin checks are the proportionate version.

## Open questions

1. **Cache eviction.** Mostly answered: the cache holds only diverged files and
   is purged on the transfer that ends the divergence. A size or age cap is
   still worth having as a backstop for files that diverge and are never
   reconciled.
2. **Text search implementation.** VS Code has no public text-search API and
   reaching for its bundled ripgrep is unsupported, so this is ours to write.
   Fine for a few thousand files; needs thought beyond that.
3. **Reranking candidate budget.** How many files to hand a model before the
   call gets slow or expensive, and whether to rank whole files or extracted
   snippets.
4. **A file size cap for the cache.** A 400MB `.sql` dump is text and currently
   qualifies. The listing already carries sizes, so the cap is cheap to add.

## Risks

- **Agents are hard on FTP.** Naive recursive exploration is slow and competes
  with the user's own transfers for the connection pool. Bounded scope, the
  binary exclusions from `Download Scripts`, and caps on depth and file count.
- **The cache is itself an exposure** — a copy of production code, and possibly
  credentials, on the laptop as a side effect of a tool call. The deny-list has
  to apply at cache-write time, not just on read. Materialisation into the
  workspace is the same problem with a more visible blast radius: server-only
  files (uploads, generated output, vendor trees) appearing in a git working
  tree as untracked noise.
- **Anything the user pastes into another application is a contract.** A path, a
  port or a token that changes underneath them fails silently and at a distance,
  in an app that is not this one. Hence the bridge at a stable path, the
  discovery file, and a snippet with nothing versioned in it.
- **A stale annotation is actively misleading.** An agent picking files from
  descriptions that no longer hold is worse off than one reading filenames. The
  keying and pruning above exist for this; serving a stale note as current is
  the bug to watch for.
- **`Download Scripts` may already be enough.** It mirrors a tree as local files,
  which every coding agent handles well, with no port and no new attack surface.
  MCP earns its keep for *live* access — trees too big to mirror, files that
  change on the server, several servers explored ad hoc. Worth being honest about
  which problem is actually being solved.
