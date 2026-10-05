// @effect-diagnostics nodeBuiltinImport:off - coordinates environment-owned store and derived projections.
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as Schema from "effect/Schema";
import { hivePaths, readHiveConfig } from "./config.ts";
import { readOptional, writeAtomic } from "./files.ts";
import { forgetHindsight, hiveDocumentId, recallHindsight, retainHindsight } from "./hindsight.ts";
import { discoverHiveSkills } from "./skills.ts";
import {
  forgetHiveFact,
  hiveMemoryDigest,
  importHiveFacts,
  readHiveMind,
  recallHiveFacts,
  rememberHiveFact,
  type HiveImportFact,
  type HiveMemory,
} from "./store.ts";
import { syncHiveVault } from "./vault.ts";

const Index = Schema.Struct({
  target: Schema.String,
  digests: Schema.Record(Schema.String, Schema.String),
});
const decodeIndex = Schema.decodeUnknownSync(Index);
const pendingSyncs = new Map<string, Promise<unknown>>();
const listeners = new Map<string, () => void>();
export function onHiveMindChange(file: string, listener: () => void) {
  const key = NodePath.resolve(file);
  listeners.set(key, listener);
  return () => {
    if (listeners.get(key) === listener) listeners.delete(key);
  };
}
export const notifyHiveMindChange = (file: string) => listeners.get(NodePath.resolve(file))?.();
const indexTarget = (url: string, bank: string) => JSON.stringify([url.replace(/\/$/u, ""), bank]);
async function readIndex(file: string, target: string) {
  const text = await readOptional(hivePaths(file).index);
  if (text === null) return {};
  const index = decodeIndex(JSON.parse(text));
  return index.target === target ? { ...index.digests } : {};
}

/** All callers share this entry point; extensions are internal projections, never competing stores. */
export async function recallHiveMind(file: string, query: string, project?: string) {
  const configuration = await readHiveConfig(file).then(
    (config) => ({ config, error: undefined }),
    (error: unknown) => ({ config: undefined, error: String(error) }),
  );
  if (!configuration.config)
    return {
      memories: (await recallHiveFacts(file, query, project, 30))
        .filter((memory) => memory.kind !== "skill")
        .slice(0, 12),
      retrieval: { status: "degraded" as const, message: `Configuration: ${configuration.error}` },
    };
  const config = configuration.config;
  const available = await availableSkills((await readHiveMind(file)).memories, config.skills ?? []);
  const active = (memory: HiveMemory) => memory.kind !== "skill" || available.has(memory.id);
  const lexical = (await recallHiveFacts(file, query, project, 30)).filter(active).slice(0, 12);
  if (!config.hindsight || !query.trim())
    return { memories: [...lexical], retrieval: { status: "local" as const } };
  try {
    const hits = await recallHindsight(config.hindsight, query);
    const current = new Map(
      (await readHiveMind(file)).memories.filter(active).map((memory) => [memory.id, memory]),
    );
    const semantic = hits.flatMap((hit) => {
      const memory = current.get(hit.metadata?.hive_id ?? "");
      // An old extraction can rank only the exact revision it indexed. Never resurrect deleted facts.
      return memory &&
        hit.document_id === hiveDocumentId(memory) &&
        hit.metadata?.hive_digest === hiveMemoryDigest(memory)
        ? [memory]
        : [];
    });
    const scores = new Map<string, number>();
    for (const list of [lexical, semantic])
      list.forEach((memory, position) =>
        scores.set(memory.id, (scores.get(memory.id) ?? 0) + 1 / (60 + position)),
      );
    const memories = [
      ...new Map([...lexical, ...semantic].map((memory) => [memory.id, memory])).values(),
    ]
      .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
      .slice(0, 12);
    return { memories, retrieval: { status: "ready" as const } };
  } catch (error) {
    return {
      memories: [...lexical],
      retrieval: { status: "degraded" as const, message: String(error) },
    };
  }
}

async function availableSkills(
  memories: ReadonlyArray<HiveMemory>,
  roots: ReadonlyArray<{ readonly path: string; readonly project?: string }>,
) {
  const available = new Set<string>();
  for (const memory of memories) {
    if (memory.kind !== "skill" || !memory.sourcePath) continue;
    const matchesRoot = roots.some((root) => {
      const relative = NodePath.relative(root.path, memory.sourcePath ?? "");
      return (
        relative !== "" &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        relative !== ".." &&
        !NodePath.isAbsolute(relative) &&
        (root.project ?? null) === memory.project
      );
    });
    if (!matchesRoot) continue;
    try {
      const stat = await NodeFSP.lstat(memory.sourcePath);
      if (stat.isFile() && !stat.isSymbolicLink()) available.add(memory.id);
    } catch {
      /* Removed or disconnected skills are retained for provenance, but not offered to agents. */
    }
  }
  return available;
}

export async function rememberHiveMind(file: string, input: HiveImportFact) {
  const result = await rememberHiveFact(file, input);
  notifyHiveMindChange(file);
  return result;
}
export async function forgetHiveMind(file: string, id: string) {
  const result = await forgetHiveFact(file, id);
  notifyHiveMindChange(file);
  return result;
}

export async function hiveMindStatus(file: string) {
  const config = await readHiveConfig(file);
  const { memories } = await readHiveMind(file);
  const index = config.hindsight
    ? await readIndex(file, indexTarget(config.hindsight.url, config.hindsight.bank))
    : {};
  const ids = new Set(memories.map((memory) => memory.id));
  return {
    name: "Hive Mind",
    records: memories.length,
    skills: memories.filter((memory) => memory.kind === "skill").length,
    vault: config.vault ?? null,
    retrievalConfigured: !!config.hindsight,
    pendingIndex: config.hindsight
      ? memories.filter((memory) => index[memory.id] !== hiveMemoryDigest(memory)).length +
        Object.keys(index).filter((id) => !ids.has(id)).length
      : 0,
    skillRoots: config.skills?.length ?? 0,
  };
}

/** Explicit synchronization drains projections and reports failures without undoing durable memory. */
export function syncHiveMind(file: string, maxIndexed = Number.POSITIVE_INFINITY) {
  const canonicalFile = NodePath.resolve(file);
  const previous = pendingSyncs.get(canonicalFile) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => synchronize(canonicalFile, maxIndexed));
  pendingSyncs.set(canonicalFile, operation);
  void operation
    .finally(() => {
      if (pendingSyncs.get(canonicalFile) === operation) pendingSyncs.delete(canonicalFile);
    })
    .catch(() => undefined);
  return operation;
}

async function synchronize(file: string, maxIndexed: number) {
  const config = await readHiveConfig(file);
  const issues: string[] = [];
  let importedSkills = 0;
  let indexed = 0;
  if (config.skills?.length) {
    const skills = await discoverHiveSkills(config.skills);
    issues.push(...skills.issues);
    const imported = await importHiveFacts(file, skills.facts, config.skills.length);
    importedSkills = imported.created + imported.updated;
  }
  let vault: Awaited<ReturnType<typeof syncHiveVault>> | null = null;
  if (config.vault) {
    try {
      vault = await syncHiveVault(file, config.vault);
      issues.push(...vault.issues);
    } catch (error) {
      issues.push(`Vault: ${String(error)}`);
    }
  }
  if (config.hindsight) {
    try {
      const target = indexTarget(config.hindsight.url, config.hindsight.bank);
      const digests = await readIndex(file, target);
      const memories = (await readHiveMind(file)).memories;
      const ids = new Set(memories.map((memory) => memory.id));
      for (const id of Object.keys(digests)) {
        if (ids.has(id)) continue;
        await forgetHindsight(config.hindsight, id);
        delete digests[id];
        await writeAtomic(hivePaths(file).index, JSON.stringify({ target, digests }, null, 2));
      }
      const pending = memories
        .filter((memory) => digests[memory.id] !== hiveMemoryDigest(memory))
        .slice(0, maxIndexed);
      // Bound each retain request; a failed batch remains pending and can be retried.
      for (let offset = 0; offset < pending.length; offset += 10) {
        const batch = pending.slice(offset, offset + 10);
        await retainHindsight(config.hindsight, batch);
        for (const memory of batch) digests[memory.id] = hiveMemoryDigest(memory);
        indexed += batch.length;
        await writeAtomic(hivePaths(file).index, JSON.stringify({ target, digests }, null, 2));
      }
    } catch (error) {
      issues.push(`Retrieval: ${String(error)}`);
    }
  }
  return { importedSkills, indexed, vault, issues, status: await hiveMindStatus(file) };
}
