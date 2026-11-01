# Local inference and fast memory references

Hive Mind already uses ONNX Runtime (native model execution) and BGE-small
embeddings. The fast path keeps a bounded resident vector snapshot, decodes each
candidate vector once per snapshot, and coalesces repeated query inference.
Snapshots refresh on file identity/size/nanosecond modification/change stamps;
index writes invalidate them. Cached query embeddings are independent of records:
every request still checks current scope, current candidate IDs and revision
digests. No retrieved answer or authorization result is cached.

The query cache holds at most 64 embeddings per model directory, across at most
eight directories. Keys are SHA-256 fingerprints, not plaintext queries. Entries
expire after 60 seconds and are pruned on subsequent access. Failed inference is
not cached. Set HIVE_MIND_INFERENCE_CACHE=off for comparative diagnostics. The
existing HIVE_MIND_SEMANTIC=off still disables local semantic inference.

## Agent interface

`hive_mind_infer_references` is a read-only MCP tool. HTTP clients can POST
/v1/inference/recall with query, projects, limit (1–32), and maxChars (500–24000).
It returns use-evidence or expand-search, bounded IDs and source metadata,
selection basis, optional cosine similarity, and runtime counters. General
memories are visible by default; project records require explicit project names.
Rejected/superseded decisions and inactive interpretations are not candidates.
Linked evidence can retrieve its current decision. References do not authorize a
future action; the agent must read the source before relying on it. All-project
read-only connectors expose this tool. Project-restricted fact-only connectors
continue to exclude linked-record tools rather than broadening their scope.

This controller combines local embedding inference with deterministic selection.
It is not a trained Jev-like decision model or a natural-language truth checker.
`calibratedConfidence` is null; cosine similarity is not a probability. Hindsight
configuration, data and normal recall remain intact. No hosted model is invoked.

## Reproducible measurement

```text
npm run bench:inference -- --models <existing BGE model directory>
```

This copies model assets into a fresh synthetic profile; it does not read personal
memories, use the live store, or download a model. On Ryzen 5 5600 / Windows /
Node 24.15.0, 120 synthetic records and six repeated queries (30 samples per
mode), warm-model retrieval measured uncached p50 5.263 ms / p95 6.164 ms versus
cached p50 0.406 ms / p95 0.511 ms. Rankings were identical. Evidence:
%TEMP%/hive-inference-benchmark-hgzxFP/result.json. These numbers exclude HTTP,
network, cold startup and any separate decision-model reranker; they do not
establish performance for unique queries or much larger real corpora.

## Jev and local alternatives

TypeSafe's official docs describe Jev as typed decision inference, not text
generation: https://docs.typesafe.ai/introduction . Jev-Mem applies that idea to
query routing, retrieval budgets, graph traversal and candidate scoring:
https://arxiv.org/abs/2609.23986 . Its benchmark claims are not Hive Mind results.

Laya is a relevant local/open-weight candidate:
https://github.com/NandhaKishorM/laya ; native runtimes include
https://github.com/lkarlslund/laya.cpp . A local decision model could rerank only
a small scope-filtered shortlist, with hard latency/token budgets and fallback
to this existing retrieval path. It must be evaluated for actual relevance,
contradiction handling, cold/warm latency and concurrent CPU load. No Laya/Jev
weights, API access, new dependencies, providers or services are installed or
activated by this increment. Prior project experiments are not runtime evidence.

## Replica preflight

GET /v1/status advertises supported/required record kinds and inference counters.
POST /v1/compatibility accepts a peer's supportedRecordKinds and optional planned
record kinds, then reports missing kinds and minimum reader version without
changing data. Missing peer capabilities are conservatively treated as legacy.
Old readers cannot be made to understand new kinds by relabeling or dropping
records. Update required readers before enabling new kinds on a shared profile.
Tests cover byte-preserving incompatibility reports and upgraded archive restore;
a live Auro upgrade/rollout is still separate and has not been performed here.
