# Local inference performance ? 0.6.3

Resident derived vector snapshots and coalesced query embeddings accelerate the
existing local ONNX BGE retrieval path. Current candidate digests are still
validated on every lookup, so corrections and forgotten records cannot reuse old
ranked results. Cache keys for queries are hashes, never plaintext. At most eight
index/model namespaces and 64 queries per namespace are retained; 60-second
query expiry is enforced on subsequent access. Failed computations are evicted.
Set HIVE_MIND_INFERENCE_CACHE=off for cache-disabled diagnostics.

The model and normal Hindsight integration are unchanged. No paid provider or
new production dependency is introduced. Typed controller/record rework is a
separate 0.7 staging feature, not part of this compatible performance release.

Reproduce with npm run bench:inference -- --models <existing BGE model directory>.
The benchmark copies only model assets into a fresh synthetic environment; it
does not read personal records or download weights. Measured on Ryzen 5600 /
Windows / Node24: uncached p50 5.263 ms, p95 6.164 ms; cached p50 0.406 ms,
p95 0.511 ms; identical rankings across 30 samples per mode, 120 records, six
repeated queries. This is warm-core latency, not end-to-end chat latency.
