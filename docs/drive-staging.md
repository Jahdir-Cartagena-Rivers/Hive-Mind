# Drive-backed store: isolated staging

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
  Even unrelated concurrent edits currently require reconciliation: this is a
  conservative checkpoint protocol, not a record-level merge implementation.
- Native Drive v3 transport with complete pagination, bounded downloads, pinned
  HTTPS resumable uploads and injected authentication. No credential or provider
  error body is logged. No network write is automatically retried after uncertainty.
- Complete archive validation using existing canonical/link/asset validators in a
  throwaway profile; empty-destination-only restore. Actual bytes, histories,
  tombstones and retry receipts survive. Restores receive a new stream identity
  and reset client consumption cursors according to existing restore semantics.
- Explicit staging CLI; export refuses a running local service, existing pending
  files are never overwritten, and restores refuse nonempty destinations. A live
  snapshot should use the existing authenticated `/v1/archive/export` endpoint.

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
node scripts/cloud-checkpoint.mjs restore <empty-target-config.json>
```

Native transport currently obtains an access token through the protected process
environment `HIVE_MIND_DRIVE_ACCESS_TOKEN`. It does not refresh that token. The
injected token provider is the extension point for direct OAuth or Composio.
Composio's chat tools are **not** automatically credentials for background scripts.
No new Google project, OAuth client, token or service-account key was created.

## Required before canonical migration

1. Persistent protected authentication on both hosts; verify exact Drive identity,
   folder permissions, scheduled execution and restart recovery. A short-lived
   access token alone is insufficient. Remote routines reportedly run no more
   frequently than every five minutes; measure this rather than claiming live sync.
2. Incremental record reconciliation and explicit conflict resolution, with stale
   client and concurrent deletion tests. No timestamp-based winner. Local service
   writes and cloud replay must share the existing mutation queue.
3. Forget-retention protocol. Current immutable checkpoints retain old encrypted
   content, so logical tombstones alone do not satisfy erasure. No real memory
   migration until retained checkpoints/assets, stale clients and key lifecycle
   have a tested erasure/retention design. No claim of deleting provider backups.
4. Protected cross-platform credential access. Existing standalone Hive Mind has
   no credential vault; Auto Apply's current portal store is Windows DPAPI. Never
   import credential values into searchable memories or source archives.
5. Initial verified snapshot, matching counts/hashes, reconnect/gap recovery and
   an operational rollback. Existing J1 memory-backend selection is preserved.

The full-snapshot staging journal is capped at 64 MiB plaintext per checkpoint,
90 MiB per downloaded object, 10,000 folder objects and 256 MiB per replay.
It needs incremental storage before high-volume long-running use. No production
service configuration, installer, live profile or canonical memory was changed.

Drive contracts checked against Google's primary documentation:
[file listing](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
and [resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
