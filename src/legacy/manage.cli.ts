// @effect-diagnostics nodeBuiltinImport:off - explicit server-local Hive Mind management command.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { hivePaths, validateHiveConfig } from "./config.ts";
import { hiveMindStatus, recallHiveMind, syncHiveMind } from "./engine.ts";
import { writeAtomic } from "./files.ts";

const args = process.argv.slice(2);
const command = args[0];
const valueAfter = (flag: string) => {
  const position = args.indexOf(flag);
  if (position < 0) return undefined;
  const value = args[position + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
  return value;
};
const target = valueAfter("--target");
if (!target || !["configure", "status", "sync", "recall"].includes(command ?? ""))
  throw new Error(
    "Use configure|status|sync|recall --target <hive-mind.json>. Configure needs --config <file>; recall needs --query <text>.",
  );
const file = NodePath.resolve(target);
let result: unknown;
if (command === "configure") {
  const source = valueAfter("--config");
  if (!source) throw new Error("Configure needs --config <JSON file>.");
  const config = validateHiveConfig(JSON.parse(await NodeFSP.readFile(source, "utf8")));
  if (args.includes("--apply")) {
    await writeAtomic(hivePaths(file).config, JSON.stringify(config, null, 2));
    result = { mode: "applied", status: await hiveMindStatus(file) };
  } else result = { mode: "preview", config };
} else if (command === "sync") {
  const synchronized = await syncHiveMind(file);
  result = synchronized;
  if (synchronized.issues.length) process.exitCode = 1;
} else if (command === "recall") {
  const query = valueAfter("--query");
  if (!query) throw new Error("Recall needs --query <text>.");
  result = await recallHiveMind(file, query, valueAfter("--project"));
} else result = await hiveMindStatus(file);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
