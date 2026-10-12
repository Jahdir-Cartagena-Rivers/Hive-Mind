// @effect-diagnostics nodeBuiltinImport:off - edits only Hive Mind's managed Markdown projection.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { parse, stringify } from "yaml";
import { ensureDirectory, readOptional, writeAtomic } from "./files.ts";
import { editHiveFact, hiveMemoryDigest, readHiveMind, type HiveMemory } from "./store.ts";

const Header = Schema.Struct({
  hive_mind: Schema.Literal(1),
  hive_id: Schema.String,
  base_digest: Schema.String,
  body_digest: Schema.String,
});
const decodeHeader = Schema.decodeUnknownSync(Header);
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text.trim()).digest("hex");
const UUID = /^[a-f0-9-]{36}$/iu;
const shortId = (id: string) => id.replaceAll("-", "").slice(0, 12);
const title = (text: string) =>
  text
    .replace(/[\/:*?"<>|#^[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80) || "Memory";
/** Readable in Obsidian's file list and graph; the id suffix keeps names unique and findable. */
const stem = (memory: HiveMemory) => `${title(memory.subject)} (${shortId(memory.id)})`;
const link = (memory: HiveMemory) => `[[${stem(memory)}|${title(memory.subject)}]]`;
export const hiveHubName = (memory: HiveMemory) => title(memory.project ?? "General memories");
const tagFor = (text: string) => text.replace(/[^\p{L}\p{N}_/-]+/gu, "-").replace(/^-+|-+$/gu, "");
/** Maps a managed note's filename to its short id; legacy UUID names are still recognized. */
const fileShortId = (name: string) => {
  const legacy = /^([a-f0-9-]{36})\.md$/iu.exec(name);
  if (legacy) return shortId(legacy[1] ?? "");
  return /\(([a-f0-9]{12})\)\.md$/u.exec(name)?.[1];
};
export const hiveNotePath = (vault: string, memory: HiveMemory) => {
  if (!UUID.test(memory.id)) throw new Error("Invalid Hive Mind projection id.");
  return NodePath.join(vault, "Hive Mind", `${stem(memory)}.md`);
};
const render = (memory: HiveMemory, related: ReadonlyArray<HiveMemory>) =>
  `---\n${stringify({
    hive_mind: 1,
    hive_id: memory.id,
    base_digest: hiveMemoryDigest(memory),
    body_digest: digest(memory.fact),
    title: memory.subject,
    kind: memory.kind ?? "memory",
    scope: memory.scope,
    project: memory.project,
    source: memory.sourceThreadId,
    updated: memory.updatedAt,
    // Property links draw edges in Obsidian's graph without touching the editable body.
    hub: `[[${hiveHubName(memory)}]]`,
    ...(related.length ? { related: related.map(link) } : {}),
    tags: [
      ...new Set(
        ["hive-mind", memory.kind ?? "memory", memory.scope, tagFor(memory.project ?? "")].filter(
          Boolean,
        ),
      ),
    ],
    ...(memory.sourcePath ? { source_path: memory.sourcePath } : {}),
  })}---\n\n${memory.fact}\n`;

function readNote(text: string, id?: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text);
  if (!match) throw new Error("Unrecognized vault note; existing file preserved.");
  const header = decodeHeader(parse(match[1] ?? ""));
  if (id !== undefined && header.hive_id !== id)
    throw new Error("Vault note identity changed; existing file preserved.");
  return { header, fact: (match[2] ?? "").trim() };
}

/** Only managed notes are editable. Metadata stays authoritative; the body is the editable fact. */
export async function syncHiveVault(
  file: string,
  vault: string,
  relatedIds: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
) {
  await ensureDirectory(vault);
  const directory = NodePath.join(vault, "Hive Mind");
  await ensureDirectory(directory);
  const all = (await readHiveMind(file)).memories;
  const byId = new Map(all.map((memory) => [memory.id, memory]));
  // Notes written before titled filenames, or before a subject was edited, move to their current name.
  const present = new Map<string, string>();
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true }))
    if (entry.isFile()) {
      const short = fileShortId(entry.name);
      if (short) present.set(short, entry.name);
    }
  for (const memory of all) {
    const existing = present.get(shortId(memory.id));
    const wanted = `${stem(memory)}.md`;
    if (!existing || existing === wanted) continue;
    try {
      if ((await readOptional(NodePath.join(directory, wanted))) === null)
        await NodeFSP.rename(NodePath.join(directory, existing), NodePath.join(directory, wanted));
    } catch {
      /* A locked or open note keeps its old name until the next pass. */
    }
  }
  // Hubs give each project a node in the graph; they are created once and never overwritten.
  await ensureDirectory(NodePath.join(vault, "Hubs"));
  for (const name of new Set(all.map(hiveHubName))) {
    const hub = NodePath.join(vault, "Hubs", `${name}.md`);
    if ((await readOptional(hub)) === null)
      await writeAtomic(
        hub,
        `# ${name}

Hive Mind hub. Open the backlinks pane to see every memory filed here.
`,
      );
  }
  let imported = 0;
  let exported = 0;
  const issues: string[] = [];
  for (const memory of all) {
    try {
      const path = hiveNotePath(vault, memory);
      const existing = await readOptional(path);
      let current = memory;
      if (existing !== null) {
        const note = readNote(existing, memory.id);
        if (digest(note.fact) !== note.header.body_digest) {
          current = await editHiveFact(file, memory.id, note.header.base_digest, note.fact);
          imported++;
        }
      }
      const related = (relatedIds.get(memory.id) ?? []).flatMap((id) => byId.get(id) ?? []);
      const next = render(current, related);
      if (existing !== next) {
        await writeAtomic(path, next);
        exported++;
      }
    } catch (error) {
      issues.push(`${memory.id}: ${String(error)}`);
    }
  }
  // A forgotten record's note is removed from the active projection without destroying its text.
  const shorts = new Set(all.map((memory) => shortId(memory.id)));
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const short = entry.isFile() ? fileShortId(entry.name) : undefined;
    if (!short || shorts.has(short)) continue;
    try {
      const path = NodePath.join(directory, entry.name);
      const text = await readOptional(path);
      if (text === null) continue;
      readNote(text);
      const archive = NodePath.join(vault, "Forgotten");
      await ensureDirectory(archive);
      const target = NodePath.join(archive, entry.name);
      if ((await readOptional(target)) !== null)
        throw new Error("Forgotten note archive already exists.");
      await NodeFSP.rename(path, target);
    } catch (error) {
      issues.push(`${entry.name}: ${String(error)}`);
    }
  }
  return { imported, exported, issues };
}
