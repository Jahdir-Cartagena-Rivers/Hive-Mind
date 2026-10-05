// @effect-diagnostics nodeBuiltinImport:off - isolated persistence fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HiveMindRuntime } from "./runtime.ts";
import { hivePaths } from "./config.ts";
import { forgetHiveMind, rememberHiveMind } from "./engine.ts";
import { hiveMemoryDigest, readHiveMind } from "./store.ts";

const directories: string[] = [];
const workers: HiveMindRuntime[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-worker-"));
  directories.push(directory);
  const file = NodePath.join(directory, "hive-mind.json");
  const runtime = new HiveMindRuntime(file);
  workers.push(runtime);
  return { directory, file, runtime, vault: NodePath.join(directory, "vault") };
}
const input = {
  scope: "project" as const,
  project: "J1Code",
  subject: "Engine decision",
  fact: "Copper cools the engine.",
  sourceThreadId: "original",
};

describe("Hive Mind environment worker", () => {
  it("exports provider saves automatically and imports vault edits on the next scan", async () => {
    const { runtime, file, vault } = await fixture();
    await runtime.configure({ version: 1, vault });
    const memory = await rememberHiveMind(file, input);
    await runtime.waitIdle();
    const note = NodePath.join(vault, "Hive Mind", `${memory.id}.md`);
    const text = await NodeFSP.readFile(note, "utf8");
    await NodeFSP.writeFile(note, text.replace(input.fact, "Aluminum cools the engine."));
    await runtime.waitIdle();
    expect((await readHiveMind(file)).memories[0]?.fact).toBe("Aluminum cools the engine.");
    expect((await runtime.snapshot()).issues).toEqual([]);
    await forgetHiveMind(file, memory.id);
    await runtime.waitIdle();
    expect((await readHiveMind(file)).memories).toHaveLength(0);
    expect(
      await NodeFSP.readFile(NodePath.join(vault, "Forgotten", `${memory.id}.md`), "utf8"),
    ).toContain("Aluminum");
  });
  it("pauses automatic projections, permits an explicit sync, and preserves config on rejection", async () => {
    const { runtime, file, vault } = await fixture();
    await runtime.configure({ version: 1, vault, automatic: false });
    const memory = await rememberHiveMind(file, input);
    await runtime.waitIdle();
    await expect(
      NodeFSP.stat(NodePath.join(vault, "Hive Mind", `${memory.id}.md`)),
    ).rejects.toThrow();
    const before = await NodeFSP.readFile(hivePaths(file).config, "utf8");
    await expect(runtime.configure({ version: 1, vault: "relative" })).rejects.toThrow();
    expect(await NodeFSP.readFile(hivePaths(file).config, "utf8")).toBe(before);
    runtime.requestSync();
    await runtime.waitIdle();
    expect((await runtime.snapshot()).phase).toBe("paused");
    expect(
      await NodeFSP.readFile(NodePath.join(vault, "Hive Mind", `${memory.id}.md`), "utf8"),
    ).toContain(input.fact);
  });
  it("rejects stale edits and preserves the newer correction", async () => {
    const { runtime, file } = await fixture();
    const memory = await rememberHiveMind(file, input);
    const revision = hiveMemoryDigest(memory);
    await runtime.mutate({
      action: "edit",
      id: memory.id,
      revision,
      fact: "The first correction.",
    });
    await expect(
      runtime.mutate({ action: "edit", id: memory.id, revision, fact: "An outdated correction." }),
    ).rejects.toThrow();
    expect((await readHiveMind(file)).memories[0]?.fact).toBe("The first correction.");
  });
  it("recovers pending extraction after a restart without replaying completed batches", async () => {
    const { runtime, file } = await fixture();
    await runtime.configure({
      version: 1,
      automatic: false,
      hindsight: { url: "http://127.0.0.1:8888", bank: "worker-test", timeoutMs: 1000 },
    });
    for (let index = 0; index < 23; index++)
      await rememberHiveMind(file, { ...input, subject: `Fact ${index}` });
    const batches: number[] = [];
    let offline = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        if (offline) throw new Error("offline");
        const body = JSON.parse(String(options.body)) as { items: unknown[] };
        batches.push(body.items.length);
        return Response.json({ success: true, async: false });
      }),
    );
    runtime.requestSync();
    await runtime.waitIdle();
    expect((await runtime.snapshot()).pendingIndex).toBe(23);
    expect((await runtime.snapshot()).issues.join()).toContain("Transport error");
    await runtime.close();
    const restored = new HiveMindRuntime(file);
    workers.push(restored);
    offline = false;
    restored.requestSync();
    await restored.waitIdle();
    expect(batches).toEqual([10, 10, 3]);
    expect((await restored.snapshot()).pendingIndex).toBe(0);
    restored.requestSync();
    await restored.waitIdle();
    expect(batches).toEqual([10, 10, 3]);
  });
});
