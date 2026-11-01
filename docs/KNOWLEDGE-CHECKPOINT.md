# Hive Mind rework checkpoint ? 2026-11-01

Objective: repair general-memory writes, then implement evidence/decision/import/
organization/view/evaluation improvements while evaluating faster native engines.
Preserve existing profiles, keys, Drive/Composio and MCP interfaces. No new
production dependencies or extra hosting. Existing rework was in this worktree;
J1 checkout has unrelated dirty work and was not modified.

## Live repair

Separate branch fix/general-memory-null-20261101, final commit 58e6b1a.
Release v0.6.2 published with installer, plugin ZIP and integrity manifests.
Installed using the standard silent installer, exit 0. Installed package reads
0.6.2. Normal J1 hive_mind_remember now succeeds with its null project field.
Private pre-update archive: ~/.hive-mind/backups/before-general-memory-fix-20261101.json.
No replacement store or credential was created. Auro was not restarted/updated.
The initial v0.6.1 release job was cancelled when publication checks exposed the
historical allowlist gap; v0.6.1 is an unpublished tag, not an installed release.
Reviewed historical paths were added explicitly; secret/content checks remain.
The release workflow now runs publication checking before packaging.

## Rework source

Version 0.7.0 is staging, not deployed. New kinds: immutable evidence, revisioned
linked decisions and model/schema/run-labeled interpretations. Imports support
normalized entries and text ChatGPT/Claude exports with explicit unsupported-item
reports. Folder capture is opt-in CLI, previews by default, admits selected text
notes only and supports watch/exclusion controls. Source dates and speakers are
retained, never inferred. Desktop exposes original evidence, decision history,
interpretation deactivation and timeline/table/evidence views. Existing graph
shows reference edges. Retrieval can find decisions through matching evidence;
rejected/superseded decisions and inactive interpretations are excluded from
working context. Forget cascades to typed derived claims, including historical
support. MCP record tools support the new data contracts.

Validation: 154 Node tests + 67 core tests passed; focused knowledge/continuity
17 passed. Synthetic retrieval evaluation covers three queries and found/fixed
source-only-query misses. Existing packaged 0.6.1 smoke passed in isolated state;
new renderer/source smoke verifies import IPC, knowledge table and provenance.
Latest build/smoke results are recorded in the final handoff.

## Performance and remaining engineering

Node baseline at 1000 records / 20 samples on Ryzen 5600: save p50 27.65 ms,
p95 56.47 ms; context p50 23.15 ms, p95 41.5 ms. Semantic index disabled.
Data: %TEMP%/hive-continuity-benchmark-nSawYF. These are baseline measurements,
not evidence that Rust or another language is faster. Rust/Go compilers are not
installed or on PATH. No speculative native code was deployed or extra production
dependency added. Next native phase requires an isolated compiler/toolchain,
representative compatible prototype and identical-workload comparisons before
choosing a language or replacing storage. Existing MCP clients remain language
independent. Organization uses connected agents; no autonomous paid model job is
started. Capture currently bounds scans to 100 files, skips notes over 12 KB and
reports truncation. Large provider exports require preprocessing into API batches.

Release boundary: peers using old BrainKind validators reject the new kinds.
Qualify mixed-version Drive clients and update required readers before deploying
0.7.0 to a shared profile; do not silently write future schemas into old replicas.
No Rust rewrite or remote-host upgrade is claimed by this checkpoint.

Final rework checks: source Electron smoke passed at
%TEMP%/hive-continuity-ui-jJS8PY (knowledge import IPC/table/provenance plus retained
image/task/graph/plugin routes); Windows dist:dir passed. Publication scan passed
160 tracked files and 70 reachable commits. Version parity: 9 plugin tests pass.
The 0.6.2 release workflow and its source/publication CI both completed successfully.
The 0.7.0 source is committed separately; it has not been installed into live state.

Packaged 0.7.0 final smoke passed at %TEMP%/hive-continuity-ui-cWRAs6, including
knowledge import IPC/table/provenance and existing task/image/graph/plugin paths.
Rework source and publication CI passed for merge 0c5de0b (run 41333490197).
Repair is on origin/main at 58e6b1a; rework is on
origin/feat/knowledge-rework-20261101. Merge reconciliation retained staging
0.7.0 metadata and the null-general-project repair; 21 service/plugin tests passed.
Remaining work is the native prototype/language comparison and mixed-reader
shared-schema rollout; neither is claimed complete by the source rework.
