import { relatedHiveMemories } from "./semantic.ts";
import { hiveMemoryDigest, readHiveMind } from "./store.ts";
import { hiveHubName } from "./vault.ts";

/** Everything the graph view draws: memories, one hub per project, and related/hub edges. */
export async function hiveGraph(file: string) {
  const { memories, continuity } = await readHiveMind(file);
  const resources = (continuity?.records ?? []).filter(
    (r) => !["client", "episode", "relation"].includes(r.kind),
  );
  const resourceIds = new Set(resources.map((r) => r.id));
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
  for (const record of resources) {
    const hub = record.project ?? "General memories";
    hubs.add(hub);
    edges.push({ source: record.id, target: `hub:${hub}`, type: "hub" });
    const references = [
      ...(Array.isArray(record.data.assetIds) ? record.data.assetIds : []),
      ...(Array.isArray(record.data.referenceIds) ? record.data.referenceIds : []),
      ...(record.data.taskId ? [record.data.taskId] : []),
    ];
    for (const id of references)
      if (typeof id === "string" && resourceIds.has(id))
        edges.push({ source: record.id, target: id, type: "related" });
  }
  for (const relation of continuity?.records ?? [])
    if (
      relation.kind === "relation" &&
      typeof relation.data.from === "string" &&
      typeof relation.data.to === "string" &&
      resourceIds.has(relation.data.from) &&
      resourceIds.has(relation.data.to)
    )
      edges.push({ source: relation.data.from, target: relation.data.to, type: "related" });
  return {
    streamId: continuity?.streamId ?? null,
    memoryRecords: memories.length,
    nodes: [
      ...memories.map((memory) => ({
        id: memory.id,
        title: memory.subject,
        project: memory.project,
        scope: memory.scope,
        kind: memory.kind ?? "memory",
        preview: memory.fact.slice(0, 200),
        updatedAt: memory.updatedAt,
      })),
      ...resources.map((r) => ({
        id: r.id,
        title: r.title,
        project: r.project,
        scope: r.scope,
        kind: r.kind,
        resource: true,
        ...(r.kind === "asset" ? { mime: r.data.mime, media: r.data.media ?? "image" } : {}),
        preview:
          [
            r.data.objective,
            r.data.statement,
            r.data.caption,
            r.data.description,
            r.data.summary,
            r.data.filename,
            r.data.relationship,
          ]
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .join(" · ")
            .slice(0, 200) ||
          (r.kind === "asset"
            ? "Retained visual reference"
            : r.kind === "collection"
              ? `${Array.isArray(r.data.assetIds) ? r.data.assetIds.length : 0} references`
              : r.title),
        updatedAt: r.updatedAt,
      })),
    ],
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
