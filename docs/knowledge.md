# Evidence and decisions

Open the workspace to create Original evidence, Decisions, and AI organization
runs. Original text cannot be overwritten: import a new entry for a corrected
source. Forget remains available and purges linked IDs from history.

Decisions have proposed/accepted/superseded/rejected states, rationale, evidence
IDs and the existing revision history. Interpretations have summary, tags,
referenceIds, model, schema, runId and active. Agents can rebuild organization by
creating a new interpretation run; deactivating an old run removes it from
working context and the knowledge view without modifying its originals.

The workspace's Decision timeline / evidence button searches titles and content,
then shows source authorship, original linked records and earlier revisions.
The existing Connections view draws reference edges. POST /v1/knowledge/view
accepts query, projects, and view (timeline, table, evidence); rows are bounded to
200 and truncation is reported. Read tokens can use this endpoint.

Import notes / normalized chats accepts explicit JSON, previews it, then imports
only after pressing Import previewed entries. POST /v1/knowledge/import accepts:

```json
{
  "scope": "project",
  "project": "Hive Mind",
  "source": {"type": "import", "threadId": "export-1", "provider": "chat-export"},
  "entries": [{"text": "Keep the original words.", "speaker": "user", "origin": "chat:42/message:7", "recordedAt": "2026-11-01T00:00:00Z"}],
  "dryRun": true
}
```

Use dryRun false to commit. Reports contain created, duplicates, excluded and
failed IDs. Batches are capped at 100 entries and HTTP requests at 64 KB. Identical
content and provenance deduplicate; changed source text becomes a separate entry.
Forgotten identities are excluded. All entries validate before the first write;
a write-time failure may leave a partial batch, explicitly reported and retryable.
Imported text is data, never executed or treated as instructions.

This is a normalized import format, not a parser for every provider's export.
Explicit folder capture is available through scripts/capture-knowledge.mjs; model-driven tagging is performed by connected agents. Agents can
create the supported versioned interpretations through hive_mind_record.

Validation: test/knowledge.test.mjs uses synthetic evidence with expected decision,
source, scope and rollback behavior. Existing bench:continuity measures context
cost/latency; neither is evidence of improved real-world model intelligence.
No new dependency, cloud hosting or sync format is introduced.


ChatGPT and Claude text exports can also be normalized by the import API using
format (`chatgpt` or `claude`) and payload in place of entries. Unsupported media
and missing speaker/date fields produce issues; no authorship or timestamp is
invented. Large exports must be split into bounded batches before API submission.

Opt-in folder capture (preview by default):

```text
node scripts/capture-knowledge.mjs --folder C:/Notes --project Notes
node scripts/capture-knowledge.mjs --folder C:/Notes --project Notes --commit --watch --exclude private,archive
```

Only UTF-8 .md/.txt notes up to 12 KB are admitted, with at most 100 per scan.
Hidden paths, symlinks, unsupported files and excluded prefixes are skipped. A
truncated scan is reported; split large roots into smaller explicit folders.
Watch repeats every five seconds and stops when its process is stopped. It does
not delete source files or erase memories when a source disappears. File time is
retained as source metadata; speaker remains unspecified. The private existing
connection descriptor is used; no extra account or credentials are created.

Run `npm run eval:knowledge` for a synthetic raw-search/working-context comparison
of current-decision retrieval, original evidence resolution, characters and
latency. No language or model-quality advantage is assumed. The evaluation found
and now covers queries matching only source evidence: linked decisions are also
retrieved, while rejected/superseded decisions stay out of working context.
Forgetting evidence also erases dependent decisions/interpretations, including
historical support, so derived claims cannot keep forgotten evidence alive.
