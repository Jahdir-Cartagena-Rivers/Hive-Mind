// @effect-diagnostics nodeBuiltinImport:off - semantic vectors are an environment-owned sidecar of the Hive Mind store.
import * as NodePath from "node:path";
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { embedTexts } from "./embedder.ts";
import * as NodeFSP from "node:fs/promises";
import { readOptional, writeAtomic } from "./files.ts";
import { hiveMemoryDigest, type HiveMemory } from "./store.ts";

const MODEL = "Xenova/bge-small-en-v1.5"; // identifies the vectors; changing it re-indexes
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const MIN_SIMILARITY = 0.5;
const BATCH = 16;
/** Hosts that cannot download or run the model can opt out; search then stays keyword-only. */
const disabled = () => process.env["HIVE_MIND_SEMANTIC"] === "off";

const Vectors = Schema.Struct({
  model: Schema.String,
  digests: Schema.Record(Schema.String, Schema.String),
  vectors: Schema.Record(Schema.String, Schema.String),
});
const decodeVectors = Schema.decodeUnknownSync(Vectors);

const paths = (file: string) => ({
  vectors: NodePath.join(
    NodePath.dirname(file),
    NodePath.basename(file) === "continuity.json"
      ? "hive-mind.continuity.vectors.json"
      : "hive-mind.vectors.json",
  ),
  models: NodePath.join(NodePath.dirname(file), "hive-mind-models"),
});
export const continuityIndexFile = (file: string) =>
  NodePath.join(NodePath.dirname(file), "continuity.json");

const memoryText = (memory: HiveMemory) => `${memory.subject}\n${memory.fact}`.slice(0, 2_000);
const encode = (vector: Float32Array) => Buffer.from(vector.buffer).toString("base64");
const decode = (text: string) => {
  const bytes = Buffer.from(text, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

type VectorSnapshot = {
  model: string;
  digests: Record<string, string>;
  vectors: Record<string, string>;
  decoded: Map<string, Float32Array>;
};
const vectorCache = new Map<string, { stamp: string; value: Promise<VectorSnapshot> }>();
const queryCaches = new Map<string, Map<string, { at: number; value: Promise<Float32Array | undefined> }>>();
const inferenceCounters = new Map<string, { hits: number; misses: number }>();
const cacheDisabled = () => process.env["HIVE_MIND_INFERENCE_CACHE"] === "off";
const MAX_INDEXES = 8;
const MAX_QUERIES = 64;
const QUERY_TTL_MS = 60_000;
const emptyVectors = (): VectorSnapshot => ({ model: MODEL, digests: {}, vectors: {}, decoded: new Map() });

async function readVectors(file: string, mutable = false) {
  const location = paths(file).vectors;
  const stat = await NodeFSP.stat(location, { bigint: true }).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) { vectorCache.delete(location); return emptyVectors(); }
  const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (cacheDisabled()) vectorCache.delete(location);
  let cached = vectorCache.get(location);
  if (cached?.stamp !== stamp) {
    const value = (async () => {
      const text = await readOptional(location, 32_000_000);
      const stored = text === null ? undefined : decodeVectors(JSON.parse(text));
      return stored?.model === MODEL ? { ...stored, decoded: new Map<string, Float32Array>() } : emptyVectors();
    })();
    cached = { stamp, value };
    vectorCache.set(location, cached);
    value.catch(() => { if (vectorCache.get(location)?.value === value) vectorCache.delete(location); });
    while (vectorCache.size > MAX_INDEXES) vectorCache.delete(vectorCache.keys().next().value!);
  }
  const stored = await cached!.value;
  // Index synchronization mutates its copy, never another in-flight reader's snapshot.
  return mutable ? { ...stored, digests: { ...stored.digests }, vectors: { ...stored.vectors } } : stored;
}

async function queryEmbedding(file: string, query: string) {
  const modelDir = paths(file).models;
  if (cacheDisabled()) return (await embedTexts(modelDir, [QUERY_PREFIX + query]))[0];
  let cache = queryCaches.get(modelDir);
  if (!cache) {
    cache = new Map(); queryCaches.set(modelDir, cache);
    inferenceCounters.set(modelDir, { hits: 0, misses: 0 });
    while (queryCaches.size > MAX_INDEXES) {
      const oldest = queryCaches.keys().next().value!;
      queryCaches.delete(oldest); inferenceCounters.delete(oldest);
    }
  }
  const queryKey = createHash("sha256").update(QUERY_PREFIX + query).digest("hex");
  const now = Date.now();
  for (const [key, entry] of cache) if (now - entry.at >= QUERY_TTL_MS) cache.delete(key);
  const existing = cache.get(queryKey);
  const counters = inferenceCounters.get(modelDir)!;
  if (existing) { counters.hits++; return existing.value; }
  counters.misses++;
  const value = embedTexts(modelDir, [QUERY_PREFIX + query]).then(vectors => vectors[0]);
  cache.set(queryKey, { at: now, value });
  while (cache.size > MAX_QUERIES) cache.delete(cache.keys().next().value!);
  value.catch(() => { if (cache!.get(queryKey)?.value === value) cache!.delete(queryKey); });
  return value;
}

/** No queries, memory text, vectors or private paths are exposed by telemetry. */
export function semanticRuntimeStatus(file: string) {
  const modelDir = paths(file).models;
  return {
    backend: "onnxruntime", model: MODEL, localOnly: true, enabled: !disabled(),
    residentIndex: vectorCache.has(paths(file).vectors),
    queryCacheEntries: queryCaches.get(modelDir)?.size ?? 0,
    queryCacheHits: inferenceCounters.get(modelDir)?.hits ?? 0,
    queryInferences: inferenceCounters.get(modelDir)?.misses ?? 0,
  };
}

export async function pendingHiveVectors(file: string, memories: ReadonlyArray<HiveMemory>) {
  if (disabled()) return 0;
  const { digests } = await readVectors(file);
  const ids = new Set(memories.map((memory) => memory.id));
  return (
    memories.filter((memory) => digests[memory.id] !== hiveMemoryDigest(memory)).length +
    Object.keys(digests).filter((id) => !ids.has(id)).length
  );
}

/** Embeds new or changed memories and drops forgotten ones. Costs milliseconds per memory, no LLM. */
export async function syncHiveVectors(file: string, memories: ReadonlyArray<HiveMemory>) {
  if (disabled()) return { embedded: 0 };
  const stored = await readVectors(file, true);
  const ids = new Set(memories.map((memory) => memory.id));
  let changed = false;
  for (const id of Object.keys(stored.digests)) {
    if (ids.has(id)) continue;
    delete stored.digests[id];
    delete stored.vectors[id];
    changed = true;
  }
  const pending = memories.filter(
    (memory) => stored.digests[memory.id] !== hiveMemoryDigest(memory),
  );
  for (let offset = 0; offset < pending.length; offset += BATCH) {
    const batch = pending.slice(offset, offset + BATCH);
    const vectors = await embedTexts(paths(file).models, batch.map(memoryText));
    batch.forEach((memory, index) => {
      stored.digests[memory.id] = hiveMemoryDigest(memory);
      stored.vectors[memory.id] = encode(vectors[index]!);
    });
    changed = true;
  }
  if (changed) {
    await writeAtomic(paths(file).vectors, JSON.stringify({ model: stored.model, digests: stored.digests, vectors: stored.vectors }));
    vectorCache.delete(paths(file).vectors);
  }
  return { embedded: pending.length };
}

/** Memories ranked by meaning, or undefined before the first index. Stale vectors are skipped so an old revision never ranks. */
export async function semanticRank(
  file: string,
  query: string,
  candidates: ReadonlyArray<HiveMemory>,
  limit = 12,
) {
  if (disabled()) return undefined;
  const stored = await readVectors(file);
  // Nothing indexed yet: don't load the model just to rank an empty set.
  if (Object.keys(stored.vectors).length === 0) return undefined;
  const queryVector = await queryEmbedding(file, query);
  if (!queryVector) return [];
  return candidates
    .flatMap((memory) => {
      const encoded = stored.vectors[memory.id];
      if (!encoded || stored.digests[memory.id] !== hiveMemoryDigest(memory)) return [];
      let vector = stored.decoded.get(memory.id);
      if (!vector) {
        vector = decode(encoded);
        if (vector.length !== 384 || !vector.every(Number.isFinite)) return [];
        stored.decoded.set(memory.id, vector);
      }
      let score = 0;
      for (let i = 0; i < vector.length; i++) score += vector[i]! * queryVector[i]!;
      return score >= MIN_SIMILARITY ? [{ memory, score }] : [];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function semanticRecall(file: string, query: string, candidates: ReadonlyArray<HiveMemory>, limit = 12) {
  return (await semanticRank(file, query, candidates, limit))?.map(hit => hit.memory);
}

const neighborCache = new Map<string, { stamp: string; links: Map<string, string[]> }>();
const NEIGHBORS = 3;
const NEIGHBOR_FLOOR = 0.65;
// ponytail: all-pairs scan is O(n^2); past this size the vault simply goes without related links.
const NEIGHBOR_LIMIT = 3_000;

/** Each memory's closest neighbors by meaning, for the vault's graph. Recomputed only when vectors change. */
export async function relatedHiveMemories(file: string, memories: ReadonlyArray<HiveMemory>) {
  const stat = await NodeFSP.stat(paths(file).vectors).catch(() => undefined);
  if (!stat || memories.length > NEIGHBOR_LIMIT) return new Map<string, string[]>();
  const stamp = `${stat.mtimeMs}:${stat.size}:${memories.length}`;
  const cached = neighborCache.get(file);
  if (cached?.stamp === stamp) return cached.links;
  const stored = await readVectors(file);
  const entries = memories.flatMap((memory) => {
    const encoded = stored.vectors[memory.id];
    return encoded && stored.digests[memory.id] === hiveMemoryDigest(memory)
      ? [{ id: memory.id, vector: decode(encoded) }]
      : [];
  });
  const links = new Map<string, string[]>();
  for (const a of entries) {
    const best: Array<{ id: string; score: number }> = [];
    for (const b of entries) {
      if (a === b) continue;
      let score = 0;
      for (let i = 0; i < a.vector.length; i++) score += a.vector[i]! * b.vector[i]!;
      if (score < NEIGHBOR_FLOOR) continue;
      best.push({ id: b.id, score });
      best.sort((x, y) => y.score - x.score);
      if (best.length > NEIGHBORS) best.pop();
    }
    if (best.length)
      links.set(
        a.id,
        best.map((entry) => entry.id),
      );
  }
  neighborCache.set(file, { stamp, links });
  return links;
}
