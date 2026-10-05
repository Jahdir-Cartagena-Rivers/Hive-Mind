// @effect-diagnostics nodeBuiltinImport:off - standalone local migration command.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { parseClaudeAccountMemory, previewNativeMemoryImport } from "./importNative.ts";
import { importHiveFacts, readHiveMind } from "./store.ts";

const args = process.argv.slice(2);
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const target = valueAfter("--target");
if (!target) {
  throw new Error("Pass --target <hive-mind.json>. Add --apply to write after preview.");
}
const home = valueAfter("--home") ?? NodeOS.homedir();
const filePath = NodePath.resolve(target);
const preview = await previewNativeMemoryImport(home);
const accountFile = valueAfter("--claude-account-memory");
const account = accountFile
  ? await (async () => {
      const source = NodePath.resolve(accountFile);
      const stat = await NodeFSP.lstat(source);
      if (!stat.isFile() || stat.size > 512_000)
        throw new Error("Claude.ai memory export must be a regular text file under 512 KB.");
      return parseClaudeAccountMemory(await NodeFSP.readFile(source, "utf8"));
    })()
  : null;
const facts = [...preview.facts, ...(account?.facts ?? [])];
const sources = preview.sources.length + (account ? 1 : 0);
const existing = await readHiveMind(filePath);
const report = {
  target: filePath,
  sourceFiles: sources,
  candidates: facts.length,
  claudeAccountEntries: account?.facts.length ?? 0,
  redactedSensitiveValues:
    preview.redactedSensitiveValues + (account?.redactedSensitiveValues ?? 0),
  existing: existing.memories.length,
};
if (!args.includes("--apply")) {
  process.stdout.write(`${JSON.stringify({ ...report, mode: "preview" }, null, 2)}\n`);
} else {
  if (facts.length === 0) throw new Error("No curated native memory facts found; no write made.");
  let backup: string | null = null;
  try {
    await NodeFSP.access(filePath);
    backup = `${filePath}.backup-${NodeCrypto.randomUUID()}`;
    await NodeFSP.copyFile(filePath, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const imported = await importHiveFacts(filePath, facts, sources);
  process.stdout.write(
    `${JSON.stringify({ ...report, mode: "applied", backup, ...imported }, null, 2)}\n`,
  );
}
