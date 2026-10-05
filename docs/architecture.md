# Architecture

The standalone service wraps the previously released MIT memory engine. It keeps
authoritative records with derived retrieval and vault views. Facts retain their
source, scope, identity, and revision. Vault corrections and retrieved facts must
agree with the current revision; forgotten records cannot be resurrected through
stale retrieval. Synchronization persists receipts and preserves conflicting edits.

The J1 edition continues to use J1's own environment lifecycle and authorization.
The standalone service owns a separate state directory, requires a bearer token,
and exposes typed memory operations through HTTP. It does not read installed J1
profiles or copy personal knowledge automatically. A failed authentication or
malformed request is rejected before executing a memory operation.

The legacy engine and schemas live in src/legacy and retain MIT. The new HTTP
service, CLI, and service tests live outside that directory and are covered by
the reserved-rights notice to the extent copyright protection applies. This
separation keeps the legal boundary explicit without altering upstream licenses.
