// @effect-diagnostics nodeBuiltinImport:off - isolated source-bank import fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { importHiveHindsight } from "./importHindsight.ts";
import {
  forgetHiveFact,
  hiveContext,
  hiveMemoryDigest,
  editHiveFact,
  readHiveMind,
} from "./store.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-import-"));
  directories.push(directory);
  return NodePath.join(directory, "hive-mind.json");
}
describe("original Hindsight knowledge import", () => {
  it("imports original source text read-only, skips its own projection, and preserves corrections and forgets on replay", async () => {
    const file = await fixture();
    const source = "Original copper checkpoint. ".repeat(100);
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, options: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: options.method ?? "GET" });
        return url.includes("offset=")
          ? Response.json({ total: 2, items: [{ id: "checkpoint" }, { id: "hive-derived" }] })
          : Response.json({
              original_text: source,
              document_metadata: { source_path: "C:\\Projects\\Auto Apply\\CHECKPOINT.md" },
            });
      }),
    );
    const first = await importHiveHindsight(file, "http://127.0.0.1:8888", "legacy");
    expect(first.documents).toBe(1);
    expect(first.created).toBe(2);
    const memories = (await readHiveMind(file)).memories;
    expect(memories.map((memory) => memory.fact).join("")).toBe(source.trim());
    expect(memories[0]?.sourcePath).toContain("CHECKPOINT.md");
    expect(hiveContext(file, "original copper checkpoint", ["Hindsight / legacy"])).toBe("");
    expect((await importHiveHindsight(file, "http://127.0.0.1:8888", "legacy")).unchanged).toBe(2);
    await editHiveFact(
      file,
      memories[0]!.id,
      hiveMemoryDigest(memories[0]!),
      "A verified correction.",
    );
    await forgetHiveFact(file, memories[1]!.id);
    const replay = await importHiveHindsight(file, "http://127.0.0.1:8888", "legacy");
    expect(replay.protected).toBe(2);
    expect(replay.created).toBe(0);
    expect((await readHiveMind(file)).memories[0]?.fact).toBe("A verified correction.");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.url.endsWith("hive-derived"))).toBe(false);
  });
  it("does not partially import if a source fails, and rejects oversized inventories", async () => {
    const file = await fixture();
    let oversized = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("offset="))
          return Response.json({
            total: oversized ? 1001 : 2,
            items: [{ id: "first" }, { id: "broken" }],
          });
        if (url.endsWith("broken")) return new Response("", { status: 503 });
        return Response.json({ original_text: "An original source." });
      }),
    );
    await expect(importHiveHindsight(file, "http://127.0.0.1:8888", "legacy")).rejects.toThrow();
    expect((await readHiveMind(file)).memories).toHaveLength(0);
    oversized = true;
    await expect(importHiveHindsight(file, "http://127.0.0.1:8888", "legacy")).rejects.toThrow(
      "1,000",
    );
  });
});
