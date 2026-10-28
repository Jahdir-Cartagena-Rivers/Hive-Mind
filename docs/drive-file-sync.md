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

The transport has passed a synthetic cross-host trial with a 3MiB retained file:
Windows seeded, the remote client joined without a redundant upload and added a
reply, Windows received that reply and forgot its seed and retained file, then the
stale remote client applied both deletions. Exact obsolete Drive revision IDs
returned404; the current decrypted archive retained the unrelated reply and no
forgotten content. This qualifies the tested path, not every provider failure.

The desktop can opt into background sync using a private `drive-sync.json` in its
Electron user-data directory. It must contain version1, enabled:true, workspace,
client, bootstrap, an absolute protectedKeyFile, optional protected
composioCredentialFile, and transportOptions with all five exact account/file
bindings listed above. Optional pollIntervalMs is between30000 and86400000;
the default is300000. No raw key or executable adapter path is accepted here.
The app runs only its packaged worker, coalesces changes, checks periodically,
and permits one worker at a time. The Sync button requests an immediate cycle.
Status distinguishes syncing, synced, conflicts, pending historical deletion,
offline access and invalid host configuration. Local memory stays available when
Drive is unavailable. Stopping the app stops its worker; this is not an OS service.

A dedicated desktop profile passed a live background pull of the synthetic reply
using a DPAPI-protected fixture key, without changing the installed connection.
Offline-worker and ordinary continuity desktop smoke tests also passed. Installed
clients remain unchanged. Real canonical data migration, protected credential
vault access, packaged deployment and the final single-executor handoff remain.
No canonical memory or application state has moved.
The old journal prototype and its successful small synthetic erasure trial remain
available as evidence. They must not be mixed with a file-mode cache or namespace.

Primary API references: [Composio proxy](https://docs.composio.dev/reference/v3/api-reference/tools/postToolsExecuteProxy),
[Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[Drive v2 file metadata](https://developers.google.com/workspace/drive/api/reference/rest/v2/files),
[revision management](https://developers.google.com/workspace/drive/api/guides/manage-revisions).

## Sealed application credentials (source staging)

`sealed-credential.mjs` can encrypt a single credential as an opaque retained file
asset. A separate HKDF-derived key and authenticated workspace, credential name
and account binding separate it from ordinary memory encryption. Neither the
password nor its plaintext account label is placed in searchable memory. The
outer Drive archive is encrypted as well. Existing asset Forget and history
erasure apply to this attachment; independent backups remain outside that scope.

The fixed `read-sealed-credential.mjs` helper consumes a small private JSON request
on stdin and returns a credential only on stdout captured by the application.
Do not invoke it as a model-facing tool or send its output to logs. Its host-owned
configuration supplies an HTTP127.0.0.1 origin, tokenFile, workspace,
protectedKeyFile, and bindings keyed by credential name; each binding supplies
the exact assetId, owner account and selected application's storePath. Another
profile, account or credential name rejects. The helper fetches only bounded
encrypted asset bytes, refuses redirects and returns no credential after Forget.
Composio's own project credential stays in the host's protected mechanism.

This source capability does not migrate any existing portal password. Account
validation at an employer and permission for final actions remain separate.

## Headless host

`node scripts/cloud-host.mjs <absolute-private-profile> <port>` runs one local
Hive service and the same background sync coordinator. The profile must already
contain enabled private drive-sync.json configuration; resolve linked parent
paths first. A newly generated local bearer token is stored0600 as service-token,
never in argv or logs. Its data/ and drive-cache/ remain separate from other
profiles. Duplicate owners reject; graceful SIGINT/SIGTERM drains the worker and
service. Status output contains no memory or credential bodies.

The process can pull and push while its machine is awake without a language-model
turn per cycle. A host-specific supervisor or wake routine must restart it after
machine shutdown; this command does not install an operating-system service or
guarantee a provider's wake schedule. Keep its launch command fixed and inherit
the protected credential environment directly, never expand secrets into argv.
