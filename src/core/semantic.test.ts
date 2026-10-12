// @effect-diagnostics nodeBuiltinImport:off - isolated filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { vi } from "vite-plus/test";
import { hivePaths } from "./config.ts";
import { hiveNotePath } from "./vault.ts";
import {
  forgetHiveMind,
  hiveMindStatus,
  recallHiveMind,
  rememberHiveMind,
  syncHiveMind,
} from "./engine.ts";

// A stand-in for the model: concepts, not words, decide similarity, so synonyms must land together.
vi.mock("./embedder.ts", () => {
  const concepts = [
    ["car", "automobile", "vehicle"],
    ["dark", "night"],
    ["database", "sqlite"],
  ];
  const embedOne = (text: string) => {
    const vector = new Float32Array(384);
    for (const word of text.toLowerCase().match(/[a-z]+/gu) ?? []) {
      const concept = concepts.findIndex((group) => group.includes(word));
      if (concept !== -1) vector[concept] = (vector[concept] ?? 0) + 1;
    }
    const length = Math.hypot(...vector) || 1;
    return vector.map((value) => value / length);
  };
  return { embedTexts: async (_dir: string, texts: string[]) => texts.map(embedOne) };
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-semantic-"));
  directories.push(directory);
  return NodePath.join(directory, "hive-mind.json");
}
const memory = (subject: string, fact: string) => ({
  scope: "general" as const,
  project: null,
  subject,
  fact,
  sourceThreadId: "thread",
});

describe("built-in semantic index", () => {
  it("finds a memory by meaning when no query word appears in it", async () => {
    const file = await fixture();
    await rememberHiveMind(file, memory("Transport", "Drives an automobile to work."));
    await rememberHiveMind(file, memory("Editor", "Prefers night themes."));
    expect((await hiveMindStatus(file)).pendingIndex).toBe(2);

    await syncHiveMind(file);

    expect((await hiveMindStatus(file)).pendingIndex).toBe(0);
    const result = await recallHiveMind(file, "car");
    expect(result.retrieval.status).toBe("ready");
    expect(result.memories.map((m) => m.subject)).toEqual(["Transport"]);
  });

  it("drops forgotten memories and re-embeds edited ones", async () => {
    const file = await fixture();
    const kept = await rememberHiveMind(file, memory("Storage", "Uses sqlite."));
    const gone = await rememberHiveMind(file, memory("Transport", "Owns a vehicle."));
    await syncHiveMind(file);

    await forgetHiveMind(file, gone.id);
    expect((await hiveMindStatus(file)).pendingIndex).toBe(1);
    await syncHiveMind(file);

    expect((await hiveMindStatus(file)).pendingIndex).toBe(0);
    expect((await recallHiveMind(file, "car")).memories).toEqual([]);
    expect((await recallHiveMind(file, "database")).memories.map((m) => m.id)).toEqual([kept.id]);
  });

  it("stays local until the first index exists", async () => {
    const file = await fixture();
    await rememberHiveMind(file, memory("Transport", "Owns a vehicle."));
    expect((await recallHiveMind(file, "vehicle")).retrieval.status).toBe("local");
  });

  it("writes titled, linked vault notes and renames legacy UUID notes", async () => {
    const file = await fixture();
    const vault = NodePath.join(NodePath.dirname(file), "vault");
    await NodeFSP.writeFile(hivePaths(file).config, JSON.stringify({ version: 1, vault }));
    const a = await rememberHiveMind(file, memory("Commute", "Drives an automobile."));
    const b = await rememberHiveMind(file, {
      ...memory("Garage", "Owns a vehicle."),
      scope: "project" as const,
      project: "Home",
    });
    const c = await rememberHiveMind(file, memory("Theme", "Prefers night colors."));
    await syncHiveMind(file);

    const text = (id: typeof a) => NodeFSP.readFile(hiveNotePath(vault, id), "utf8");
    const noteA = await text(a);
    expect(noteA).toContain(`[[${NodePath.basename(hiveNotePath(vault, b), ".md")}|Garage]]`);
    expect(noteA).not.toContain("Theme");
    expect(await text(c)).not.toContain("related:");
    expect(await text(b)).toContain(`hub: "[[Home]]"`);
    await expect(NodeFSP.stat(NodePath.join(vault, "Hubs", "Home.md"))).resolves.toBeDefined();

    const legacy = NodePath.join(vault, "Hive Mind", `${a.id}.md`);
    await NodeFSP.rename(hiveNotePath(vault, a), legacy);
    await syncHiveMind(file);
    await expect(NodeFSP.stat(legacy)).rejects.toThrow();
    expect(await text(a)).toContain(`hive_id: ${a.id}`);
  });
});
