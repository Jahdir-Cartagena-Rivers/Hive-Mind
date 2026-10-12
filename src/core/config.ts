// @effect-diagnostics nodeBuiltinImport:off - environment-owned local configuration boundary.
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { HiveMindConfig } from "./contracts.ts";
import { readOptional } from "./files.ts";
export { HiveMindConfig };
const decodeConfig = Schema.decodeUnknownSync(HiveMindConfig);

export const hivePaths = (file: string) => ({
  config: NodePath.join(NodePath.dirname(file), "hive-mind.config.json"),
  index: NodePath.join(NodePath.dirname(file), "hive-mind.index.json"),
});

export function validateHiveConfig(value: unknown): HiveMindConfig {
  const config = decodeConfig(value);
  for (const path of [
    config.vault,
    config.localEngine?.directory,
    config.localEngine?.ollama,
    ...(config.skills ?? []).map((root) => root.path),
  ]) {
    if (path !== undefined && !NodePath.isAbsolute(path))
      throw new Error("Hive Mind vault and skill paths must be absolute server paths.");
  }
  if ((config.skills?.length ?? 0) > 32)
    throw new Error("Hive Mind supports up to 32 skills folders.");
  if (config.localEngine) {
    if (!config.hindsight)
      throw new Error("Local engine recovery requires a retrieval URL and bank.");
    const url = new URL(config.hindsight.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Local engine recovery is available only for a loopback retrieval URL.");
  }
  if (config.hindsight) {
    const url = new URL(config.hindsight.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Hive Mind retrieval URL must be HTTP(S), without embedded credentials.");
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(config.hindsight.bank))
      throw new Error("Hive Mind retrieval bank needs a stable alphanumeric name.");
    const timeout = config.hindsight.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000)
      throw new Error("Hive Mind retrieval timeout must be between 100 and 60,000 ms.");
  }
  return config;
}

export async function readHiveConfig(file: string): Promise<HiveMindConfig> {
  const text = await readOptional(hivePaths(file).config);
  return text === null ? { version: 1 } : validateHiveConfig(JSON.parse(text));
}
