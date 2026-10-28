# Drive-backed store: isolated staging

The later [conditional single-file prototype](drive-file-sync.md) uses capabilities
verified through Composio's authenticated API proxy. It avoids this journal's
whole-history replay and unknown-part cleanup problem. Both remain source staging;
do not mix their caches or assume an installed/canonical migration has occurred.

User decision2026-10-27: **Forget must also erase the selected content from retained
Drive history**, keeping content-free deletion markers to block stale resurrection.
Offline clients apply it when they reconnect. Selecting this policy does not itself
request deletion of any existing memory. Source staging now implements encrypted
erasure markers, sanitized checkpoint replacements and folder-scoped permanent
deletion. Offline regression coverage passes; live-provider erasure qualification
and the production gates below remain required before real migration.

The target is one canonical Drive-backed Hive Mind shared by independently running
desktop and remote clients. This branch implements the first checkpoint/transport
layer. It does **not** turn the installed service into a cloud-synced service yet.
Do not point an ordinary Hive Mind state directory at a Drive desktop-sync folder:
the existing process lock and atomic local saves cannot coordinate two computers.

## Implemented

- Dependency-free AES-256-GCM encrypted full archives, bound to a workspace ID.
  The 32-byte key stays outside Drive. Content-addressed ciphertext filenames make
  retries inspectable; save pending bytes before uploading and retry those bytes.
- Immutable parent-linked checkpoints; every duplicate name is verified. Missing
  ancestry, wrong keys/workspaces, corruption, future versions and incomplete
  listings reject. Competing branches are preserved and reported as conflicts.
  The three-way merge module combines independent changes to memories/records and
  retry receipts; competing edits retain both source archives and report conflicts.
  Memory tombstones suppress stale corrections while a deliberate re-remember
  after observing a forget follows the existing store semantics. Brain record IDs
  remain permanently forgotten. Merged assets and links require full validation.
  Protocol2 checkpoints can reconcile multiple parent heads; protocol1 remains readable.
- History erasure publishes an encrypted content-free memory/record ID marker
  before cleanup. Each affected archive is sanitized, validated with the production
  archive/link/asset parser, uploaded and verified before the original is permanently
  deleted. Protocol3 aliases preserve logical ancestry for offline clients. All
  clients sharing the namespace must support this protocol; older clients fail
  closed. New subject tombstones are hashes; old plaintext markers are normalized.
  Offline pending uploads and encrypted caches are sanitized before retry. An
  explicit new remember after observed deletion receives a new identity. Unrelated
  memories and retry receipts remain. Independent copies of the same text are
  separate records; this is identity-based erasure rather than semantic search.
- Chunk cleanup removes parts exclusively referenced by a deleted checkpoint.
  Unknown orphan parts, including interrupted uploads or lost delete acknowledgements,
  are not blindly deleted while another writer could own them. They yield
  `historyErasure.erased:false` and CLI exit3; coordinated orphan recovery remains
  a production gate. A successful sync is not proof of completed erasure. Drive API
  calls cannot purge provider internal backups or disconnected client copies.
- Native Drive v3 transport with complete pagination, bounded downloads, pinned
  HTTPS resumable uploads and injected authentication. No credential or provider
  error body is logged. No network write is automatically retried after uncertainty.
- Chunked transport wrapper for Composio's small-upload tools: encrypted checkpoints
  above3MiB become immutable content-addressed parts and a final small manifest.
  Interrupted part uploads leave no committed checkpoint; retries verify/reuse
  existing parts. Missing/corrupt duplicates and reassembly hashes reject. The
  routine wraps both native and custom transports; all clients must support this
  envelope before sharing chunked checkpoints. Parts contain ciphertext only.
- Complete archive validation using existing canonical/link/asset validators in a
  throwaway profile; empty-destination-only restore. Actual bytes, histories,
  tombstones and retry receipts survive. Restores receive a new stream identity
  and reset client consumption cursors according to existing restore semantics.
- Explicit staging CLI; export refuses a running local service, existing pending
  files are never overwritten, and restores refuse nonempty destinations. A live
  snapshot should use the existing authenticated `/v1/archive/export` endpoint.
- Optional live compare-and-apply APIs, disabled by default. Start the source CLI
  with `HIVE_MIND_CLOUD_SYNC=1` to allow full-token-only POST `/v1/cloud/snapshot`
  and `/v1/cloud/apply`. Snapshot returns an archive plus revision. Apply validates
  all bytes/links first, compares the current revision inside the existing mutation
  queue, preserves the local stream identity and emits new local sequence events.
  Concurrent edits, lost tombstones/receipts, unmarked deletions and forgotten-ID
  resurrection reject. Unreferenced forgotten asset bytes are collected locally.
- Resumable replica coordinator with an encrypted local base/pending cache. Explicit
  `seed`, `join` or `resume` direction prevents accidental merging of unrelated
  nonempty stores. Uncertain uploads reuse exact pending bytes; a new local edit
  between transfer and apply rejects stale writes and is merged on retry. Two
  synthetic service owners exchange independent edits and retain conflicts.

## Commands

Run `npm run test:cloud`. Neighboring integration checks:
`node --test test/service.test.mjs test/continuity.test.mjs`.

Create a private config outside source control with `workspace`, `client`,
`folderId`, absolute `keyFile`, absolute `stateDirectory` and absolute
`pendingFile`. The key file must contain exactly 32 random bytes. For later
checkpoints set `parent` to the observed current ciphertext digest. Config must
contain no credential values. Node 24.13+ and existing lockfile dependencies apply.

```
node scripts/cloud-checkpoint.mjs prepare <config.json>
node scripts/cloud-checkpoint.mjs publish <config.json>
node scripts/cloud-checkpoint.mjs inspect <config.json>
node scripts/cloud-checkpoint.mjs reconcile <new-pending-config.json>
node scripts/cloud-checkpoint.mjs restore <empty-target-config.json>
```

Native transport currently obtains an access token through the protected process
environment `HIVE_MIND_DRIVE_ACCESS_TOKEN`. It does not refresh that token. The
injected token provider is the extension point for direct OAuth or Composio.
Composio's chat tools are **not** automatically credentials for background scripts.
No new Google project, OAuth client, token or service-account key was created.

For the already configured Platform route, `src/composio-drive-transport.mjs`
exports a folder-bound adapter. Set only `COMPOSIO_API_KEY` through the host's
protected credential mechanism. `transportOptions` must explicitly contain
`folderId`, `userId` and `connectedAccountId`; there are no private account defaults.
The five Drive tools, including permanent delete, are pinned to20261022_00 because omitted versions use the
older frozen schema. For You `ck_` consumer keys require MCP and are rejected here.
No Google OAuth token is exported. Project credentials are sent only to Composio;
signed storage transfers never receive that header. Provider error bodies are
discarded, downloads/parents are checked, and uncertain Drive writes are not
blindly replayed. This deterministic storage adapter extends the existing bound
remote script path rather than introducing another agent or identity system.

The adapted transport has offline rejection tests and an independently replayed
read-only live provider check. An actual encrypted synthetic Windows-to-remote-to-
Windows exchange through the one-cycle CLI retained both test-note identities in a
separate private qualification folder. This is a small exchange, not sustained sync.
No real memory or credential payload was uploaded. Retained source/evidence from
the remote implementation stays in the private transition workspace, not this repo.

API contracts checked against [tool execution](https://docs.composio.dev/reference/v3/api-reference/tools/postToolsExecuteByToolSlug)
and [staged file uploads](https://docs.composio.dev/reference/v3/api-reference/files/postFilesUploadRequest).

`node scripts/cloud-sync-once.mjs <private-config.json>` runs one resumable cycle.
Config names `workspace`, `client`, `keyFile`, `tokenFile`, loopback `origin`,
`cacheDirectory`, explicit `bootstrap`, and either native `folderId` or an absolute
reviewed `transportModule` exporting `createTransport(transportOptions)`. An adapter
implements async `list(): {id,name}[]`, `read(id): Buffer`, `create(name,bytes)`.
For erasure it also implements folder-scoped `remove(id,expectedName)` using
permanent deletion, not Drive trash. `historyErasure` defaults to true; disabling it
is a synthetic diagnostic setting and does not meet the approved Forget contract.
Do not load executable adapter paths from memories or cloud payloads. The routine
does not schedule itself, export tokens, modify installed apps or choose credentials.

## Required before canonical migration

1. Persistent protected authentication on both hosts; verify exact Drive identity,
   folder permissions, scheduled execution and restart recovery. A short-lived
   access token alone is insufficient. Remote routines reportedly run no more
   frequently than every five minutes; measure this rather than claiming live sync.
2. Qualify the resumable coordinator with the actual remote Composio transport,
   implement explicit resolution of reported competing edits and qualify dependent-record
   deletion, multi-parent/criss-cross ancestry and stale clients. The staging CLI
   reconciles exactly two heads with one unique common base and writes a pending
   checkpoint for a separate publish. Only the opt-in live service API may modify
   a running profile; it shares the existing mutation queue. Installed desktop
   configuration, credential provisioning and scheduled product operation remain
   unqualified. A new client starts with an empty dedicated profile, never a clone
   that can silently claim ownership of active tasks.
3. Live qualification of the new history-erasure path, including chunk cleanup,
   stale clients and key lifecycle. Coordinated recovery of unknown orphan parts
   remains unimplemented. No real migration or claim of deleting provider backups.
4. Protected cross-platform credential access. Existing standalone Hive Mind has
   no credential vault; Auto Apply's current portal store is Windows DPAPI. Never
   import credential values into searchable memories or source archives.
5. Initial verified snapshot, matching counts/hashes, reconnect/gap recovery and
   an operational rollback. Existing J1 memory-backend selection is preserved.

The full-snapshot staging journal is capped at 64 MiB plaintext per checkpoint,
90 MiB per downloaded object, 10,000 folder objects and 256 MiB per replay.
It needs incremental storage before high-volume long-running use. No production
service configuration, installer, live profile or canonical memory was changed.
Encrypted replica state also shares the64MiB plaintext envelope limit; base/pending
transaction overhead counts toward it. The cache supports replacement beyond the
ordinary projection file's4MB limit; a real retained3MiB file is covered in tests.

Drive contracts checked against Google's primary documentation:
[file listing](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
and [resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
