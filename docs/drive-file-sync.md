# Conditional Drive file sync - source staging

The initial immutable journal was built against the connected Drive tools' limited
write interface. A later live **synthetic-only** capability probe verified that the
existing Composio Platform connection also exposes authenticated API proxy calls:

- Drive v2 supplies an ETag. Metadata and media updates with a stale real ETag
  return412 without overwriting the file.
- A6MiB base64 JSON request exceeds the proxy request limit (413). A resumable
  update using1MiB binary chunks succeeded with exact checksums. Two sessions
  opened with the same ETag were tested: after one committed, the other returned412
  at completion and preserved the winner's bytes.
- Permanent deletion of an obsolete binary revision succeeded while preserving
  the current revision. These are observed probe results, not an API-wide SLA.

This enables a smaller source-only sync path using the same encryption, archive
validation, three-way merge and serialized local apply as journal staging. It reads
one current encrypted file rather than replaying every checkpoint. A local encrypted
cache retains the client's last merged base, so offline changes can merge after old
cloud backup revisions are removed. Competing corrections are still conflicts.
Unchanged polls check the file binding/ETag without downloading the archive again.

## Ownership and safeguards

Provision a NEW dedicated binary file in the private folder and configure its exact
file ID and expected name on every client. Never discover the canonical file by
taking the first matching name. Its encrypted packet contains a random persistent
instance ID. A different instance, an emptied previously bound file, or missing
permanent deletion markers rejects before a local replacement.

`CloudFileReplica` requires an explicit `seed`, `join` or `resume`. An unbound join
must use an empty dedicated local profile. Join and ordinary pulls do not upload a
redundant version. Every write saves its exact encrypted pending bytes, expected
ETag and before-state first. A conditional rejection keeps that state for a bounded
retry/rebase; an uncertain accepted write is recognized by its ciphertext digest.
Local edits racing apply are preserved by the existing revision check.

## Forget and revision retention

The encrypted packet records exact obsolete head revision IDs from successful
conditional updates. Drive revision listing is not trusted to enumerate arbitrarily
large history completely. Normally, three prior backup revisions are retained;
older tracked revisions are permanently deleted. The cached merge base does not
depend on those backup files staying available.

When new permanent Forget IDs are observed, the new canonical archive excludes
those memories/records and their managed references/assets. The coordinator then
purges ALL tracked earlier backup revisions, since a previous full snapshot can
contain the forgotten content. Other current memories and their existing record
histories/receipts remain in the current archive. This policy removes historical
whole-store backups as part of Forget; it does not rewrite immutable Drive revisions.

Cleanup failure leaves a durable encrypted purge inventory. Sync can succeed while
`historyErasure.erased` remains false; CLI exit3 distinguishes that condition.
Subsequent edits retain the outstanding erasure request. The file transport must
recheck exact folder/name/binary-file binding and forbid deletion of the current
head. A missing obsolete revision counts as already removed. These API operations
do not erase provider internal backups or copies on disconnected computers.

## Configuration and remaining qualification

The existing source routine accepts `storageMode:"file"` and a reviewed absolute
`transportModule` exporting `createFileTransport`. Transport configuration supplies
`folderId`, `fileId`, `expectedName`, `userId` and `connectedAccountId`. The key is
read from the existing protected host mechanism; no Google token is exported.
Cloud encryption keys remain outside Drive. Installed clients are not configured
by this source change. Use separate profile/cache/file IDs for synthetic testing.

For protected keys, configure the built-in `src/cloud-key.mjs` as `keyProviderModule`
with `keyProviderOptions.file` instead of a raw `keyFile`. Windows current-user
DPAPI protects the key; headless hosts encrypt it with a domain-separated key
derived from their existing masked Composio credential. The latter must remain
available on that host. Credential rotation requires reprovisioning from a host
that still has its key; never silently create a replacement master.

One-time X25519 provisioning exposes only public recipient keys and an encrypted
master-key envelope. Pin the recipient fingerprint and transfer fingerprint through
the existing trusted orchestration channel; do not learn them from Drive alone.
Private identity and master keys are stored only in host-protected packets. Windows
may also use a DPAPI-protected `composioCredentialFile`; headless hosts continue
using their masked credential environment. No key or credential is put in command
arguments, general memory, logs or plaintext temporary files. Key creation uses
exclusive writes, rejects linked paths and preserves existing material on failure.
Generated-key tests include native Windows DPAPI; real provisioning is a separate
operational step, not something source installation performs automatically.

The source transport adapter, real cross-host file-mode trial, full-size real-store
preflight, restart/scheduling, protected credential vault and final single-executor
handoff still need qualification. No canonical memory or application state has moved.
The old journal prototype and its successful small synthetic erasure trial remain
available as evidence. They must not be mixed with a file-mode cache or namespace.

Primary API references: [Composio proxy](https://docs.composio.dev/reference/v3/api-reference/tools/postToolsExecuteProxy),
[Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[Drive v2 file metadata](https://developers.google.com/workspace/drive/api/reference/rest/v2/files),
[revision management](https://developers.google.com/workspace/drive/api/guides/manage-revisions).
