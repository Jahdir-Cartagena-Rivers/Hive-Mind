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
const notePath = (vault: string, memory: HiveMemory) => {
  if (!/^[a-f0-9-]{36}$/iu.test(memory.id)) throw new Error("Invalid Hive Mind projection id.");
  return NodePath.join(vault, "Hive Mind", `${memory.id}.md`);
};
const render = (memory: HiveMemory) =>
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
    ...(memory.sourcePath ? { source_path: memory.sourcePath } : {}),
  })}---\n\n${memory.fact}\n`;

function readNote(text: string, id: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text);
  if (!match) throw new Error("Unrecognized vault note; existing file preserved.");
  const header = decodeHeader(parse(match[1] ?? ""));
  if (header.hive_id !== id)
    throw new Error("Vault note identity changed; existing file preserved.");
  return { header, fact: (match[2] ?? "").trim() };
}

/** Only managed notes are editable. Metadata stays authoritative; the body is the editable fact. */
export async function syncHiveVault(file: string, vault: string) {
  await ensureDirectory(vault);
  await ensureDirectory(NodePath.join(vault, "Hive Mind"));
  let imported = 0;
  let exported = 0;
  const issues: string[] = [];
  for (const memory of (await readHiveMind(file)).memories) {
    try {
      const path = notePath(vault, memory);
      const existing = await readOptional(path);
      let current = memory;
      if (existing !== null) {
        const note = readNote(existing, memory.id);
        if (digest(note.fact) !== note.header.body_digest) {
          current = await editHiveFact(file, memory.id, note.header.base_digest, note.fact);
          imported++;
        }
      }
      const next = render(current);
      if (existing !== next) {
        await writeAtomic(path, next);
        exported++;
      }
    } catch (error) {
      issues.push(`${memory.id}: ${String(error)}`);
    }
  }
  // A forgotten record's note is removed from the active projection without destroying its text.
  const ids = new Set((await readHiveMind(file)).memories.map((memory) => memory.id));
  for (const entry of await NodeFSP.readdir(NodePath.join(vault, "Hive Mind"), {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.md$/iu.test(entry.name)) continue;
    const id = entry.name.slice(0, -3);
    if (ids.has(id)) continue;
    try {
      const path = NodePath.join(vault, "Hive Mind", entry.name);
      const text = await readOptional(path);
      if (text === null) continue;
      readNote(text, id);
      const archive = NodePath.join(vault, "Forgotten");
      await ensureDirectory(archive);
      const target = NodePath.join(archive, entry.name);
      if ((await readOptional(target)) !== null)
        throw new Error("Forgotten note archive already exists.");
      await NodeFSP.rename(path, target);
    } catch (error) {
      issues.push(`${id}: ${String(error)}`);
    }
  }
  return { imported, exported, issues };
}
