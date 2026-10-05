// @effect-diagnostics nodeBuiltinImport:off - reads allowlisted skill files without running their instructions.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { parse } from "yaml";
import type { HiveMindConfig } from "./config.ts";
import type { HiveImportFact } from "./store.ts";

const SkillHeader = Schema.Struct({ name: Schema.String, description: Schema.String });
const decodeSkillHeader = Schema.decodeUnknownSync(SkillHeader);

/** A skill catalog records descriptions and locations; discovery does not execute a skill. */
export async function discoverHiveSkills(roots: NonNullable<HiveMindConfig["skills"]>) {
  const facts: HiveImportFact[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    try {
      const files: string[] = [];
      await visit(root.path, files, 0);
      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        try {
          const text = await NodeFSP.readFile(file, "utf8");
          const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
          if (!header) throw new Error("SKILL.md needs name and description in YAML frontmatter.");
          const skill = decodeSkillHeader(parse(header[1] ?? ""));
          if (!skill.name.trim() || !skill.description.trim())
            throw new Error("Empty skill metadata.");
          const hash = NodeCrypto.createHash("sha256").update(file).digest("hex");
          facts.push({
            kind: "skill",
            scope: root.project ? "project" : "general",
            project: root.project ?? null,
            subject: `Skill / ${skill.name.slice(0, 130)} / ${hash.slice(0, 8)}`,
            fact: skill.description.slice(0, 2_000),
            sourcePath: file,
            sourceThreadId: `skill:${hash}`,
          });
        } catch (error) {
          issues.push(`${file}: ${String(error)}`);
        }
      }
    } catch (error) {
      issues.push(`${root.path}: ${String(error)}`);
    }
  }
  return { facts, issues };
}

async function visit(directory: string, files: string[], depth: number): Promise<void> {
  if (depth > 8) return;
  const stat = await NodeFSP.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("Skill roots must be real directories.");
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name.startsWith("."))
      continue;
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) await visit(path, files, depth + 1);
    else if (entry.isFile() && entry.name === "SKILL.md") {
      if (files.length >= 500) throw new Error("Hive Mind skill root exceeds 500 skills.");
      const stat = await NodeFSP.stat(path);
      if (stat.size > 512_000) throw new Error("Skill file exceeds 512 KB.");
      files.push(path);
    }
  }
}
