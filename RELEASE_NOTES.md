# Hive Mind 0.6.3

Speed up repeated local semantic memory references by retaining bounded derived
vector snapshots and coalescing identical query-embedding inference. Index file
changes invalidate snapshots; every result still checks current candidate IDs
and revision digests. No answer, authorization result or plaintext query key is
cached. Failed inference retries; cache use can be disabled for diagnostics.

A warm-model CPU benchmark on 120 synthetic memories measured median lookup
5.263 ms uncached vs 0.406 ms cached with identical rankings. This excludes
HTTP/network, cold startup and separate decision-model reranking.

Existing storage, Drive schemas, Hindsight configuration and plugin interfaces
are preserved. This release does not include the staged 0.7 record kinds or the
new typed-reference controller. MCP now reports the correct package version.
