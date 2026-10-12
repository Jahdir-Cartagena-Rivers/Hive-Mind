import { relatedHiveMemories } from "./semantic.ts";
import { hiveMemoryDigest, readHiveMind } from "./store.ts";
import { hiveHubName } from "./vault.ts";

/** Everything the graph view draws: memories, one hub per project, and related/hub edges. */
export async function hiveGraph(file: string) {
  const { memories } = await readHiveMind(file);
  const related = await relatedHiveMemories(file, memories);
  const edges: Array<{ source: string; target: string; type: "hub" | "related" }> = [];
  const seen = new Set<string>();
  for (const [id, ids] of related)
    for (const other of ids) {
      const key = id < other ? `${id}|${other}` : `${other}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: id, target: other, type: "related" });
    }
  const hubs = new Set<string>();
  for (const memory of memories) {
    const hub = hiveHubName(memory);
    hubs.add(hub);
    edges.push({ source: memory.id, target: `hub:${hub}`, type: "hub" });
  }
  return {
    nodes: memories.map((memory) => ({
      id: memory.id,
      title: memory.subject,
      project: memory.project,
      scope: memory.scope,
      kind: memory.kind ?? "memory",
      preview: memory.fact.slice(0, 200),
      updatedAt: memory.updatedAt,
    })),
    hubs: [...hubs].map((name) => ({ id: `hub:${name}`, title: name })),
    edges,
  };
}

/** One record with its full text, edit revision and nearest neighbors. */
export async function hiveMemoryDetail(file: string, id: string) {
  const { memories } = await readHiveMind(file);
  const memory = memories.find((entry) => entry.id === id);
  if (!memory) return undefined;
  const byId = new Map(memories.map((entry) => [entry.id, entry]));
  const related = (await relatedHiveMemories(file, memories)).get(id) ?? [];
  return {
    memory: { ...memory, revision: hiveMemoryDigest(memory) },
    related: related.flatMap((otherId) => {
      const other = byId.get(otherId);
      return other ? [{ id: other.id, title: other.subject }] : [];
    }),
  };
}
