# OB1 assessment and shared conversation continuity

Status: implemented in working source, 2026-10-23. Isolated service and desktop
verification is recorded in IMPLEMENTATION-CHECKPOINT.md. Installed applications
and live profiles have not been migrated or updated.

## Desired behavior

Opening another chat, project, or connected AI should preserve relevant shared
understanding. Chats remain separate conversation surfaces; project identity
controls the working context. Explicitly continuing an existing task in another
project should carry its decisions, corrections, blockers, and next action.

Availability across projects does not mean automatically injecting every
project's instructions into every conversation.

J1 Code keeps its own built-in store as the default primary brain. Standalone
Hive Mind is an optional primary backend selected by the user. Sharing does not
require replacing J1's default or running the standalone app. Within either
mode, memory tools and automatic context must use the same selected authority.

## Source findings

Reviewed OB1 commit `238df6cefd307745d1fe49d10b96797903bf25ac`:

- [Agent Memory API](https://github.com/NateBJones-Projects/OB1/blob/238df6cefd307745d1fe49d10b96797903bf25ac/integrations/agent-memory-api/README.md):
  runtime-neutral recall, compact write-back, review, inspection, and recall traces.
- [TaskFlow work log](https://github.com/NateBJones-Projects/OB1/blob/238df6cefd307745d1fe49d10b96797903bf25ac/recipes/openclaw-taskflow-work-log/README.md):
  portable attempts, failures, open questions, and next steps across agents.
- [Write-back contract](https://github.com/NateBJones-Projects/OB1/blob/238df6cefd307745d1fe49d10b96797903bf25ac/recipes/openclaw-agent-memory/contracts/writeback.schema.json):
  task/thread/runtime provenance, idempotency, content hashes, and retention.
- [OpenClaw plugin](https://github.com/NateBJones-Projects/OB1/blob/238df6cefd307745d1fe49d10b96797903bf25ac/integrations/openclaw-agent-memory/plugin/src/index.ts):
  additive prompt and searchable-corpus hooks. The prompt asks the model to write
  back after meaningful work; this is not guaranteed runtime capture or a
  subscription delivering new conversation state to every client.
- [Storage portability](https://github.com/NateBJones-Projects/OB1/blob/238df6cefd307745d1fe49d10b96797903bf25ac/docs/agent-memory-portability.md):
  the shipped backend uses Supabase/Postgres; SQLite is a future adapter idea.
  Reusing these contract patterns does not require replacing Hive Mind's storage.

## Baseline before implementation

Initial source findings, before the changes described below:

- `src/core/engine.ts` notifies the in-process runtime after remember/forget.
  `src/core/runtime.ts` starts automatic projection sync from that notification.
  Saved facts do not universally wait for a polling interval.
- `src/service.mjs` reconciles every 30 seconds. `app/ui/app.js` refreshes the
  visible desktop graph every five seconds. Neither is conversation capture.
- The standalone MCP surface exposes explicit memory tools; it does not consume
  every provider's messages. Its remember handler currently uses the shared
  source label `hive-mind-mcp`, rather than a caller-specific chat identity.
- In `C:/Projects/J1_Code`, the Hive Mind MCP handlers and ProviderService's
  automatic context injection both read the J1 server's own `hive-mind.json`.
  Those checked paths do not route through this standalone service. A common
  product name therefore does not imply a connection between the two stores.
  Keeping the built-in store is intentional; selecting standalone Hive Mind as
  J1's primary brain requires an additional integration.
- Existing automatic context is bounded by project and topic. Corrections and
  retrieval are revision-aware. Preserve those protections.
- Memories currently store text, source thread identity, and an optional source
  path. A path or URL can be written into a fact, but there is no dedicated image
  asset/reference model, automatic image capture, binary retention, or image
  retrieval pipeline. J1 chat attachments remain separately owned by J1.

## Implementation contract

1. **Select one authority per mode.** Introduce a shared backend boundary for J1
   memory tools and pre-turn context assembly. Default to J1's existing built-in
   store. Offer standalone Hive Mind as an optional primary backend, configured
   through a service connection and securely held credential. Route all memory
   operations and context through the selected backend. Preserve both stores;
   switching must not silently copy, merge, or delete data. Offer explicit import
   separately with source identity and revision checks. Report external service
   outages rather than silently writing to the built-in store while external
   mode is selected. Switching back restores use of the existing local store.
2. **Capture at runtime events.** Record connected-client turn IDs, explicit user
   corrections, task transitions, tool outcomes, and source references durably.
   Separate short-lived conversation continuity from durable facts. Save compact
   task state; keep the originating transcript in its existing owner store.
   Extraction may run asynchronously and must not promote model claims to user
   facts. Adapters require actual host lifecycle hooks; an MCP tool list alone
   cannot observe a host's full conversation.
3. **Publish committed changes.** Add ordered change sequences and resumable
   subscriptions, with a bounded changes endpoint for reconnect recovery. Commit
   state and its change record atomically, then notify subscribers. Choose the
   storage mechanism during implementation; a separate best-effort JSON append
   beside a state write would leave a crash-consistency gap. Use stable event IDs
   for retries, revision checks for concurrent edits, and durable forget events.
4. **Refresh before every turn.** Read the current sequence and obtain the latest
   applicable task state, corrections, preferences, and retrieved facts. Pass a
   bounded context packet into each provider's next request. Attach a task ID
   across chats when continuing work, even if the project surface changes. Keep
   unrelated project instructions scoped. Record the context sequence consumed.
5. **Move expensive projections off the critical path.** Embed, build graph
   links, and reconcile vault/Hindsight asynchronously. Fresh canonical facts
   and recent continuity state must be usable before embedding completes.
   Replace display polling with committed-change notifications where supported;
   retain periodic reconciliation as recovery.
6. **Make freshness inspectable.** Show committed, indexed, and client-consumed
   sequences, pending extraction, disconnected clients, and context sources.
   Distinguish a durable save from an agent actually receiving that save.

## First acceptance test

In isolated state, connect two clients through the same authority:

1. In chat A, make an explicit correction and acknowledge its committed sequence.
2. Immediately open chat B with the same task, including from another project.
3. Verify B's next provider request includes the correction and task state, with
   the consumed sequence at least as new as A's acknowledgement.
4. Verify B does not receive unrelated project instructions. Compare a normal
   new task and an explicitly continued task across the same projects.
5. Repeat with disconnected/reconnected clients, duplicate delivery, concurrent
   edits, service restart, and forgotten records. Check no loss, duplicate facts,
   stale overwrite, or resurrection; reject unauthorized reads/writes.
6. Repeat with semantic indexing unavailable or delayed. Current canonical
   corrections must remain accessible without waiting for the index.
7. Run the relevant suite in both built-in and external backend modes. Built-in
   mode must work without the standalone app. Switching modes must preserve each
   store; a failed external connection must not cause writes to the local store.

## Required visual memory support

Hive Mind must function as an independent brain with durable visual memory.
For work such as modeling, it must remember reference images the user likes,
what the user likes about them, and make the actual images available to a later
AI conversation. A caption, URL, or temporary file path alone is insufficient.

Add these capabilities to the implementation backlog:

- **Preserve the reference.** Support explicit image capture/import into managed
  Hive Mind asset storage, independent of the originating chat or temporary
  file. Preserve the original; thumbnails and previews are derived assets.
  External links may retain provenance, but a successfully retained reference
  must remain usable after the original URL expires or local file is removed.
- **Link meaning to the image.** Store asset ID, content hash, MIME type,
  dimensions, source chat/message, capture time, and memory/project/task links.
  Associate the user's stated likes, dislikes, intended use, and relevant parts
  of the image. For modeling, this can include shape, proportions, materials,
  color, or particular details when the user identifies them. Keep user-stated
  preferences distinct from model-generated descriptions and inferred taste.
- **Retrieve visual examples.** Support queries such as "use the modeling
  references I liked" and return matching images together with the associated
  preferences and provenance. Use text and visual similarity where appropriate;
  image similarity alone must not establish that the user likes an image.
- **Deliver images to the AI.** Expose authorized asset retrieval through the
  service/client boundary so connected vision-capable providers receive actual
  image bytes or an accessible attachment, alongside the relevant preference.
  Resolve assets in the receiving client's environment instead of assuming it
  can open the original machine's path. Report missing assets and unsupported
  vision capability explicitly.
- **Keep continuity and control.** Make references available across chats and
  connected providers within their scope. Project examples remain scoped;
  explicitly shared general preferences can apply across projects. Support
  preference corrections, replacing references, export/import of assets with
  metadata, and explicit forgetting. Content hashes deduplicate image storage
  without merging distinct preferences or source attribution. Asset cleanup
  must respect remaining references and the user's deletion request.

Acceptance: retain an image and the user's explanation of what they like about
it in chat A; remove the original temporary file; open chat B, including through
another connected vision-capable provider; ask for the modeling references the
user liked. Verify that B receives the preserved image and the correct stated
preference, rather than only a caption or broken path. Repeat after restart and
export/import, and test corrected preferences, duplicate imports, project scope,
unauthorized access, and forgotten references. Neither obsolete preferences nor
forgotten references may reappear through stale retrieval.

## Accepted extensions

- Living task records preserve objectives, decisions, failed attempts, questions,
  next actions and status outside a chat. Provider terminal events are evidence,
  not an automatic declaration that the task is done.
- Visual collections retain actual images, notes and normalized image regions.
  Coarse appearance matching supplements caption/meaning search; it does not
  infer that the user likes a similar-looking image.
- Artifact versions link retained model, document, source and image bytes to
  revision history. Latest and preferred versions are independent. The service
  rejects exhausted history limits rather than silently dropping old versions.
- Preferences retain their applicability, exceptions and source. Edits create
  history while automatic context uses the current revision. Agent notes remain
  labeled as evidence; no automatic promotion to general user taste.
- Bounded working context combines a selected task, relevant scoped records,
  canonical facts and asset references. It reports omissions and distinguishes
  selected/delivered evidence from agent-reported use.
- Simultaneous chats coordinate through expiring task claims and revision checks.
  This records ownership and conflicts; it does not start autonomous workers or
  grant permission to perform a task's actions.
- Regression checks exercise cross-chat context and retained bytes, corrections,
  stale indexes, history, concurrent edits, replay, restart, restore, forgetting,
  authentication, and backend switching. Dedicated Electron smoke and canonical
  latency measurements supplement unit/API tests without claiming model-quality
  improvements or live provider-account validation.

## Continuity performance and runtime boundaries

Measure save acknowledgement, event delivery, context assembly, and extraction
lag independently at p50/p95 with dataset size and hardware recorded. Subsecond
delivery of committed updates is the initial target. The isolated metadata
benchmark measured total save/event/context p50 80.94 ms and p95 144.24 ms across
20 updates to 1,000 tasks; this excludes indexing, image transfer, model latency
and cross-machine networking. See the checkpoint for retained evidence.

An already-running model response cannot be updated through memory delivery
alone; new context takes effect at a supported turn/tool boundary. Third-party
clients without capture and context hooks cannot promise the same continuity.

## Source and rollout scope

The implementation spans this standalone repository and J1's memory selection,
shared engine, provider context, MCP and settings paths. The inherited project
validation change in `src/service.mjs` and its tests was preserved. No production
dependencies were added. Existing installed applications, profiles, connection
configuration and stored memories were not migrated. Release/install remains a
separate rollout; checkpoint evidence distinguishes source, isolated runtime
checks, and unperformed live-account/device verification.
