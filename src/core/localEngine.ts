// @effect-diagnostics nodeBuiltinImport:off - persistent detached service ownership is a Node process boundary.
// @effect-diagnostics globalDate:off - records captured process start receipts alongside server-owned logs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import type { HiveMindConfig } from "./contracts.ts";
import { ensureDirectory, writeAtomic } from "./files.ts";

export type EndpointHealth = "ready" | "absent" | "occupied";
export function probeHiveEndpoint(url: string): Promise<EndpointHealth> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(url);
      return response.status >= 200 && response.status < 300
        ? ("ready" as const)
        : ("occupied" as const);
    }).pipe(
      Effect.timeout("2 seconds"),
      Effect.catch(() => Effect.succeed("absent" as const)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    ),
  );
}
type Launch = (
  name: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) => Promise<boolean>;

/** Restores the installed engine without modifying it or stopping shared services when J1 exits. */
export class HiveLocalEngine {
  private readonly probe: (url: string) => Promise<EndpointHealth>;
  private readonly launch: Launch;
  private readonly children = new Map<string, NodeChildProcess.ChildProcess>();
  private readonly host: { platform: string; environment: NodeJS.ProcessEnv };
  constructor(
    logDirectory: string,
    host: { platform: string; environment: NodeJS.ProcessEnv },
    options?: { probe: (url: string) => Promise<EndpointHealth>; launch: Launch },
  ) {
    this.host = host;
    this.probe = options?.probe ?? probeHiveEndpoint;
    this.launch =
      options?.launch ??
      (async (name, command, args, cwd) => {
        const previous = this.children.get(name);
        if (previous && previous.exitCode === null && !previous.killed) return false;
        await ensureDirectory(logDirectory);
        const output = await NodeFSP.open(NodePath.join(logDirectory, `${name}.log`), "a");
        try {
          const child = NodeChildProcess.spawn(command, [...args], {
            cwd,
            detached: true,
            windowsHide: true,
            stdio: ["ignore", output.fd, output.fd],
          });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          this.children.set(name, child);
          child.unref();
          await writeAtomic(
            NodePath.join(logDirectory, `${name}.json`),
            JSON.stringify(
              { pid: child.pid, command, args, cwd, startedAt: new Date().toISOString() },
              null,
              2,
            ),
          );
          return true;
        } finally {
          await output.close();
        }
      });
  }
  async ensure(config: HiveMindConfig) {
    if (!config.localEngine || !config.hindsight) return;
    const issues: string[] = [];
    const start = async (
      name: string,
      healthUrl: string,
      command: string,
      args: ReadonlyArray<string>,
      cwd: string,
    ) => {
      const health = await this.probe(healthUrl);
      if (health === "ready") return;
      if (health === "occupied")
        throw new Error(`${name} endpoint is occupied; its response is not healthy.`);
      const stat = await NodeFSP.lstat(command);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`${name} executable is not a regular file.`);
      await this.launch(name, command, args, cwd);
      issues.push(`${name} is starting; synchronization will retry automatically.`);
    };
    const root = config.localEngine.directory;
    const ollama =
      config.localEngine.ollama ??
      (this.host.platform === "win32" && this.host.environment.LOCALAPPDATA
        ? NodePath.join(this.host.environment.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe")
        : undefined);
    if (ollama)
      await start(
        "hive-model",
        "http://127.0.0.1:11434/api/tags",
        ollama,
        ["serve"],
        NodePath.dirname(ollama),
      );
    const python = NodePath.join(
      root,
      ".venv",
      this.host.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    await start(
      "hive-retrieval",
      `${config.hindsight.url.replace(/\/$/u, "")}/health`,
      python,
      [NodePath.join(root, "run_api.py")],
      root,
    );
    if (issues.length) throw new Error(issues.join(" "));
  }
}
