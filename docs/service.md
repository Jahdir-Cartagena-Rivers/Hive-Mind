# Standalone service

Install Node.js 24.13 or newer, then run `npm ci`. The runtime
dependencies are the same Effect and YAML versions already used by the J1 core.
The semantic model downloads on first sync (see desktop.md). No browser or Hindsight installation is performed automatically.

In PowerShell, create a token in the current process and start a separate state
directory:

```powershell
$env:HIVE_MIND_TOKEN = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
npm start -- --state-dir C:\Knowledge\HiveMindStandalone --port 8788
```

Provide that token to authorized clients through their secure credential storage.
Do not put it in a URL, repository, or command argument. Optional
`HIVE_MIND_READ_TOKEN` grants status/search access without mutation permission.
The server binds to loopback and rejects browser-origin requests. Remote access
requires a separately configured authenticated proxy; no public listener is
enabled by default.

All `/v1` operations require `Authorization: Bearer <token>`. POST requests use
`Content-Type: application/json` with at most 64 KiB of JSON, except the bounded
asset and backup imports below. `/health` returns
only readiness and product identity without authentication.

| Method and path      | JSON body / behavior                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| GET `/v1/status`     | Configuration and synchronization status.                                                      |
| POST `/v1/search`    | `query`, optional `project`; returns current facts and revisions.                              |
| POST `/v1/remember`  | `scope`, optional `project`, `subject`, `fact`, optional validated `sourceThreadId`. |
| POST `/v1/edit`      | `id`, `revision`, `fact`; a stale revision returns 409.                                        |
| POST `/v1/forget`    | `id`; records a durable forget operation.                                                      |
| POST `/v1/configure` | Configuration version 1 with optional vault, Hindsight, skills, automatic, localEngine fields. |
| POST `/v1/sync`      | `{}`; waits for the current synchronization drain.                                             |
| POST `/v1/import`    | `url`, `bank`; explicit read-only import of an original Hindsight source bank.                 |

## Continuity and retained references

| Operation | Behavior |
| --- | --- |
| POST `/v1/brain` | List by `kind`, `id`, `query`, or `projects`; use `includeHistory` for version inspection. Returns the store's `streamId` and committed `sequence`. Up to 200 matches per request; refine the query when `total` is larger. |
| POST `/v1/brain/save` | Save a task, preference, collection, artifact, episode, entity, relation, or client receipt. Supply the current `revision` when editing and a stable `eventId` for retryable writes. A stale revision or reused event ID with different content returns 409. |
| POST `/v1/brain/forget` | `id`, `revision`; removes the record and its history, purges links, and collects unreferenced asset bytes. Shared bytes remain while another asset record uses them. |
| POST `/v1/tasks/claim` | `id`, `revision`, `owner`, optional `seconds` (1–3600), `release`; leases coordinate chats without replacing revision checks. |
| POST `/v1/assets` | Retain base64 PNG/JPEG/WebP/GIF with `title`, `scope`, optional `project`, and truthful `source`. Image limit 10 MiB; JSON limit about 14 MiB. |
| POST `/v1/files` | Retain an opaque model, document or source file with `base64`, `filename`, `title`, `scope` and optional project/source. File limit 25 MiB; JSON limit about 35 MiB. Files are not executed. |
| GET `/v1/assets/:id` | Retrieve actual bytes with authentication. Missing or forgotten references return 404. Integrity is checked against the stored content hash. |
| POST `/v1/visual-search` | `assetId`, optional `projects`, `limit`; finds identical images or compares compatible coarse appearance descriptors. It does not infer user taste. |
| POST `/v1/working-context` | `query`, `projects`, optional `taskId`, `clientId`, `threadId`, `maxChars` (1000–24000); assembles current scoped evidence and up to six asset references. Explicit task continuation may bring that task's project context into another project surface. |
| POST `/v1/changes` | `after`, optional `streamId`; returns ordered committed change metadata. An expired cursor, future sequence, or different store returns 409 so the client can reload a snapshot. |
| GET `/v1/events` | Authenticated event stream. Reconnect with `Last-Event-ID: <streamId>:<sequence>`. `ready` reports the current head; only delivered change event IDs advance the client's cursor. Slow clients disconnect and replay. |
| POST `/v1/archive/export` | Export canonical records, histories, source metadata, retry receipts and retained bytes. Maximum archive size 64 MiB. Protect backups as personal data. |
| POST `/v1/archive/import` | Restore an archive into an empty dedicated environment; conflicting/nonempty destinations are rejected. Validates data and bytes before committing. Restores receive a new stream identity; client consumption receipts reset while task bindings survive. |

Record kinds and data shapes are described in the MCP `hive_mind_record` tool.
Collections support per-image notes and normalized `x`, `y`, `width`, `height`
regions. Artifacts retain prior data snapshots and may select a `preferredRevision`
independently of the latest revision. Normal edits retain up to 100 prior
revisions, then reject further changes rather than silently dropping history;
client freshness receipts intentionally retain only their current state.
The store permits 10,000 continuity records and 20,000 idempotency receipts.

The existing atomic store commits record changes and sequence metadata together.
Only one service process may own a state directory. A terminated owner's lock
can be recovered on restart; a live owner is rejected. Assets are stored before
metadata acknowledgement. Derived semantic indexes and the Markdown vault remain
asynchronous; fresh canonical state is available before indexing completes.

Context diagnostics distinguish selected evidence from actual provider use.
Unambiguous continuation requests can discover an existing task by name; an
explicitly named task can bring its project context into another chat. Ambiguous
matches are reported without selecting a task. Set `discoverTask: false` to
disable discovery. Oversized fields are compacted with `truncated: true`; their
complete values remain available through record retrieval.

`usedIds` in a context packet is retained as a compatibility alias for
`selectedIds`; client receipts use `deliveredIds` for material delivered to a
provider and reserve `usedIds` for agent-reported use. Neither proves what a model
reasoned from internally. If records do not fit, diagnostics report the omission;
retrieve those records explicitly rather than assuming the complete task fitted.
J1's per-turn episodes retain the delivered record IDs and context stream/sequence
so later turns do not overwrite the earlier delivery trace.

## Live chat presence

Chats can see what other chats are doing right now. Presence is ephemeral service
memory: it never touches the durable store, its revisions or the change history,
and it is lost on restart.

- `POST /v1/presence` (write token): `{chatId, provider, status: working|waiting|idle,
  step?, title?, project?, taskId?}`; `{action: "end", chatId}` removes a chat. Repeat
  about every 30 seconds while working. Working and waiting entries expire after two
  minutes without a heartbeat; idle ones linger for ten minutes.
- `POST /v1/presence/list` (read token): `{projects?, excludeChatId?}`. Project-scoped
  entries are visible only to callers naming that project, like memories.
- `GET /v1/events` also emits `event: presence` (no cursor) with the full list whenever a
  status, step, task or project changes; repeated heartbeats are silent.
- Working-context packets include a short "Other chats right now" block (never the
  requesting chat), and flag a chat that is working on the same task. This is a soft
  claim: it warns, it does not lock; the revision checks still protect task edits.
- MCP: `hive_mind_presence` (`list`, `update`, `end`) lets any agent report and read.

Step labels are short summaries, not tool output. Do not report secrets or commands.

For configuration examples see `examples/hive-mind.config.example.json`. Paths
belong to the service host and must be absolute. Vault notes can be edited in
Obsidian after configuration. Skills are cataloged rather than executed. Local
engine recovery, if explicitly configured, reuses the existing installation.

The standalone service refuses installed `.j1`/`.t3` paths, symlinked state paths,
or directories with an application state database/settings file. It does not
migrate J1 data automatically. Keep its state and vault dedicated to this service.
Stop with Ctrl+C; restart with the same state directory to preserve records.

The desktop app embeds this service; see [desktop.md](desktop.md) for the graph
interface, the MCP endpoint, and connecting other applications.
