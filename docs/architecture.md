# Architecture

Hive Mind uses one authoritative store and derived capabilities around it. The same memory operations serve native J1 settings, provider MCP tools, and Dot's separately authorized memory connection.

## Authority and provenance

Each record has a stable ID, a scope, a subject, a fact, a source thread ID, and timestamps. Optional fields identify a skill, source file, or original import source. The current store is versioned JSON in the selected J1 server's userdata directory, written atomically. Retrieval and vault state remain projections of those records.

A content fingerprint covers the canonical record. Edits carry the fingerprint of the version they started from. If that version has changed or been forgotten, the edit fails instead of overwriting the newer record.

Forgetting persists the memory identity in a tombstone list. Imports cannot recreate that identity on replay. An explicit new remember operation can intentionally restore it. Imported corrections retain their original source identity.

## Context and search

Automatic turn context selects relevant general facts and current-project facts. Skills, unrelated project facts, ambiguous imported preferences, and Hindsight source imports are excluded from automatic injection. Explicit searches can discover cross-project knowledge; the project argument is a ranking hint, not a search isolation filter.

Semantic search accepts a Hindsight result only when its document ID, canonical ID, and revision fingerprint agree with a current record. The returned text comes from canonical memory. Old or deleted revisions cannot be restored through retrieval. A retrieval outage falls back to local fact search and reports the degraded state.

## Synchronization and recovery

One environment-owned worker wakes after a save and checks external edits every 30 seconds. Its retrieval batches contain at most ten changed records. Index receipts identify the target URL/bank and completed record fingerprints, so a restart can skip already completed revisions.

Vault notes have managed identities and base/body fingerprints in frontmatter. Only their body is editable. A conflicting external edit is preserved and reported. Forgotten managed notes move to a separate archive folder. Unrecognized files are left intact.

Skills are discovered from allowlisted folders with traversal limits and symlink rejection. Their frontmatter descriptions become catalog entries; their instructions are not executed by discovery. Skills use the same recall route, while remaining excluded from automatic conversational context.

Existing-knowledge import reads original Hindsight documents through GET requests. It skips Hive Mind's own projection documents and gathers sources before applying the import. Source documents up to 128 KiB are divided into excerpts; inventory and excerpt limits bound the request. The source bank remains unchanged.

Optional local recovery probes the configured loopback services before starting an existing installation. It uses exact executable paths, hidden detached processes, and PID/log receipts. Healthy shared services are reused. The recovery path does not install dependencies, download models, or stop shared services when J1 exits.

## Authorization and extension boundaries

Environment RPCs distinguish read, operate, and access-management permissions. Configuration and source-bank import require access management; memory writes and manual sync require operate permission. Dot's separate OAuth read/write grants remain in place.

New capabilities belong at an adapter boundary. Preserve canonical identity and revisions, distinguish source imports from derived retrieval, expose failures, and retain project/provenance rules. Current adapters are implemented in source rather than loaded from a dynamic plugin registry.

## Read the code

These links pin the working implementation to a specific commit:

| Area | Source |
| --- | --- |
| Canonical store and corrections | [store.ts](https://github.com/Jahdir-Cartagena-Rivers/J1Code/blob/d709391df467a41c08c4b39767868b3808ce4666/apps/server/src/hiveMind/store.ts) |
| Unified retrieval and synchronization | [engine.ts](https://github.com/Jahdir-Cartagena-Rivers/J1Code/blob/d709391df467a41c08c4b39767868b3808ce4666/apps/server/src/hiveMind/engine.ts) |
| Environment worker | [runtime.ts](https://github.com/Jahdir-Cartagena-Rivers/J1Code/blob/d709391df467a41c08c4b39767868b3808ce4666/apps/server/src/hiveMind/runtime.ts) |
| Revision-checked Markdown | [vault.ts](https://github.com/Jahdir-Cartagena-Rivers/J1Code/blob/d709391df467a41c08c4b39767868b3808ce4666/apps/server/src/hiveMind/vault.ts) |
| Skills discovery | [skills.ts](https://github.com/Jahdir-Cartagena-Rivers/J1Code/blob/d709391df467a41c08c4b39767868b3808ce4666/apps/server/src/hiveMind/skills.ts) |
| Original Hindsight import | [importHindsight.ts](https://github.com/Jahdir-Cartagena-Rivers/J1Code/blob/d709391df467a41c08c4b39767868b3808ce4666/apps/server/src/hiveMind/importHindsight.ts) |
| Wire contracts | [hiveMind.ts](https://github.com/Jahdir-Cartagena-Rivers/J1Code/blob/d709391df467a41c08c4b39767868b3808ce4666/packages/contracts/src/hiveMind.ts) |
| Native management page | [HiveMindSettings.tsx](https://github.com/Jahdir-Cartagena-Rivers/J1Code/blob/d709391df467a41c08c4b39767868b3808ce4666/apps/web/src/components/settings/HiveMindSettings.tsx) |
