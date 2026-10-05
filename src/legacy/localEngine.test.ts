// @effect-diagnostics nodeBuiltinImport:off - isolated engine ownership fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { HiveLocalEngine, type EndpointHealth } from "./localEngine.ts";
import { validateHiveConfig } from "./config.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-engine-"));
  directories.push(directory);
  const python = NodePath.join(directory, ".venv", "Scripts/python.exe");
  await NodeFSP.mkdir(NodePath.dirname(python), { recursive: true });
  await NodeFSP.writeFile(python, "fixture");
  const ollama = NodePath.join(directory, "ollama");
  await NodeFSP.writeFile(ollama, "fixture");
  const config = validateHiveConfig({
    version: 1,
    hindsight: { url: "http://127.0.0.1:8888", bank: "test" },
    localEngine: { directory, ollama },
  });
  return { directory, python, ollama, config };
}
describe("Hive Mind local engine recovery", () => {
  it("leaves already healthy shared services alone", async () => {
    const { config, directory } = await fixture();
    const starts: string[] = [];
    const engine = new HiveLocalEngine(
      directory,
      { platform: "win32", environment: {} },
      {
        probe: async () => "ready",
        launch: async (name) => {
          starts.push(name);
          return true;
        },
      },
    );
    await engine.ensure(config);
    await engine.ensure(config);
    expect(starts).toEqual([]);
  });
  it("restores absent services using exact executable paths and reports readiness separately", async () => {
    const { config, directory, python, ollama } = await fixture();
    const starts: unknown[] = [];
    let health: EndpointHealth = "absent";
    const engine = new HiveLocalEngine(
      directory,
      { platform: "win32", environment: {} },
      {
        probe: async () => health,
        launch: async (name, command, args, cwd) => {
          starts.push({ name, command, args, cwd });
          return true;
        },
      },
    );
    await expect(engine.ensure(config)).rejects.toThrow("starting");
    expect(starts).toEqual([
      { name: "hive-model", command: ollama, args: ["serve"], cwd: directory },
      {
        name: "hive-retrieval",
        command: python,
        args: [NodePath.join(directory, "run_api.py")],
        cwd: directory,
      },
    ]);
    health = "ready";
    await engine.ensure(config);
    expect(starts).toHaveLength(2);
  });
  it("rejects occupied endpoints, missing executables, and remote local-engine configurations", async () => {
    const { config, directory, python } = await fixture();
    let health: EndpointHealth = "occupied";
    let starts = 0;
    const engine = new HiveLocalEngine(
      directory,
      { platform: "win32", environment: {} },
      {
        probe: async () => health,
        launch: async () => {
          starts++;
          return true;
        },
      },
    );
    await expect(engine.ensure(config)).rejects.toThrow("occupied");
    expect(starts).toBe(0);
    health = "absent";
    await NodeFSP.unlink(python);
    await expect(engine.ensure(config)).rejects.toThrow();
    expect(starts).toBe(1);
    expect(() =>
      validateHiveConfig({ ...config, hindsight: { url: "https://example.com", bank: "test" } }),
    ).toThrow("loopback");
  });
});
