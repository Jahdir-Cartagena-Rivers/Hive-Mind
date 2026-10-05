// @effect-diagnostics nodeBuiltinImport:off - isolated filesystem and local HTTP integration fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { hivePaths, validateHiveConfig } from "./config.ts";
import {
  forgetHiveMind,
  hiveMindStatus,
  recallHiveMind,
  rememberHiveMind,
  syncHiveMind,
} from "./engine.ts";
import { hiveContext, hiveMemoryDigest, importHiveFacts, readHiveMind } from "./store.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(config: Record<string, unknown> = {}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-hive-unified-"));
  directories.push(directory);
  const file = NodePath.join(directory, "hive-mind.json");
  await NodeFSP.writeFile(hivePaths(file).config, JSON.stringify({ version: 1, ...config }));
  return { file, directory };
}
const input = {
  scope: "project" as const,
  project: "J1Code",
  subject: "Release decisions",
  fact: "Use staged replacement for the running backend.",
  sourceThreadId: "thread-original",
};
const hindsight = { url: "http://127.0.0.1:8888", bank: "isolated-test", timeoutMs: 1000 };

describe("unified Hive Mind", () => {
  it("retains legacy behavior without extensions and rejects invalid configuration", async () => {
    const { file } = await fixture();
    await rememberHiveMind(file, input);
    expect((await recallHiveMind(file, "backend")).memories[0]?.fact).toBe(input.fact);
    expect((await recallHiveMind(file, "backend")).retrieval.status).toBe("local");
    expect(() => validateHiveConfig({ version: 2 })).toThrow();
    expect(() => validateHiveConfig({ version: 1, vault: "relative" })).toThrow();
    expect(() =>
      validateHiveConfig({ version: 1, hindsight: { ...hindsight, url: "file:///tmp" } }),
    ).toThrow();
    expect(() =>
      validateHiveConfig({ version: 1, hindsight: { ...hindsight, timeoutMs: 0 } }),
    ).toThrow();
  });

  it("imports vault edits, preserves provenance and protects newer corrections", async () => {
    const { file, directory } = await fixture();
    const vault = NodePath.join(directory, "vault");
    await NodeFSP.writeFile(hivePaths(file).config, JSON.stringify({ version: 1, vault }));
    const memory = await rememberHiveMind(file, input);
    expect((await syncHiveMind(file)).vault?.exported).toBe(1);
    const note = NodePath.join(vault, "Hive Mind", `${memory.id}.md`);
    const original = await NodeFSP.readFile(note, "utf8");
    await NodeFSP.writeFile(
      note,
      original.replace(input.fact, "Replace the backend only after active workers drain."),
    );
    expect((await syncHiveMind(file)).vault?.imported).toBe(1);
    const edited = (await readHiveMind(file)).memories[0];
    expect(edited?.id).toBe(memory.id);
    expect(edited?.originSourceThreadId).toBe(input.sourceThreadId);
    expect(edited?.sourceThreadId).toBe(`vault:${memory.id}`);
    expect((await importHiveFacts(file, [input], 1)).protected).toBe(1);

    const stale = await NodeFSP.readFile(note, "utf8");
    await rememberHiveMind(file, { ...input, fact: "User correction from another chat." });
    await NodeFSP.writeFile(note, stale.replace(edited?.fact ?? "", "A conflicting vault edit."));
    const report = await syncHiveMind(file);
    expect(report.issues.join(" ")).toMatch(/conflict/);
    expect((await readHiveMind(file)).memories[0]?.fact).toBe("User correction from another chat.");
    expect(await NodeFSP.readFile(note, "utf8")).toContain("A conflicting vault edit.");
  });

  it("refreshes unchanged notes and archives forgotten ones without resurrecting imports", async () => {
    const { file, directory } = await fixture();
    const vault = NodePath.join(directory, "vault");
    await NodeFSP.writeFile(hivePaths(file).config, JSON.stringify({ version: 1, vault }));
    const memory = await rememberHiveMind(file, input);
    await syncHiveMind(file);
    await rememberHiveMind(file, { ...input, fact: "A newer correction." });
    expect((await syncHiveMind(file)).issues).toEqual([]);
    const note = NodePath.join(vault, "Hive Mind", `${memory.id}.md`);
    expect(await NodeFSP.readFile(note, "utf8")).toContain("A newer correction.");
    await forgetHiveMind(file, memory.id);
    await syncHiveMind(file);
    expect((await readHiveMind(file)).memories).toHaveLength(0);
    expect(
      await NodeFSP.readFile(NodePath.join(vault, "Forgotten", `${memory.id}.md`), "utf8"),
    ).toContain("A newer correction.");
    expect((await importHiveFacts(file, [input], 1)).protected).toBe(1);
    await rememberHiveMind(file, input);
    expect((await readHiveMind(file)).memories).toHaveLength(1);
  });

  it("catalogs skills without executing or injecting their instructions", async () => {
    const { file, directory } = await fixture();
    const skills = NodePath.join(directory, "skills");
    await NodeFSP.mkdir(skills);
    await NodeFSP.writeFile(
      NodePath.join(skills, "SKILL.md"),
      "---\nname: release-audit\ndescription: Check staged backend replacement and release evidence.\n---\nRun arbitrary shell commands here.\n",
    );
    await NodeFSP.writeFile(
      hivePaths(file).config,
      JSON.stringify({ version: 1, skills: [{ path: skills, project: "J1Code" }] }),
    );
    expect((await syncHiveMind(file)).importedSkills).toBe(1);
    expect((await syncHiveMind(file)).importedSkills).toBe(0);
    const memory = (await recallHiveMind(file, "release-audit")).memories[0];
    expect(memory?.kind).toBe("skill");
    expect(memory?.sourcePath).toBe(NodePath.join(skills, "SKILL.md"));
    expect(memory?.fact).not.toContain("arbitrary shell");
    expect(hiveContext(file, "release-audit backend replacement", ["J1Code"])).toBe("");
    await forgetHiveMind(file, memory?.id ?? "");
    await syncHiveMind(file);
    expect((await hiveMindStatus(file)).skills).toBe(0);
  });

  it("hides disconnected and removed skills while preserving their source records", async () => {
    const { file, directory } = await fixture();
    const skills = NodePath.join(directory, "skills");
    await NodeFSP.mkdir(skills);
    const skillFile = NodePath.join(skills, "SKILL.md");
    await NodeFSP.writeFile(
      skillFile,
      "---\nname: source-audit\ndescription: Audit evidence sources.\n---\n",
    );
    await NodeFSP.writeFile(
      hivePaths(file).config,
      JSON.stringify({ version: 1, skills: [{ path: skills }] }),
    );
    await syncHiveMind(file);
    expect((await recallHiveMind(file, "source-audit")).memories).toHaveLength(1);
    await NodeFSP.writeFile(hivePaths(file).config, JSON.stringify({ version: 1 }));
    expect((await recallHiveMind(file, "source-audit")).memories).toHaveLength(0);
    expect((await readHiveMind(file)).memories).toHaveLength(1);
    await NodeFSP.writeFile(
      hivePaths(file).config,
      JSON.stringify({ version: 1, skills: [{ path: skills }] }),
    );
    await NodeFSP.rm(skillFile);
    expect((await recallHiveMind(file, "source-audit")).memories).toHaveLength(0);
  });

  it("uses semantic ranking but returns canonical text and ignores stale/deleted index revisions", async () => {
    const { file } = await fixture({ hindsight });
    const memory = await rememberHiveMind(file, input);
    const hits = [
      {
        document_id: `hive-${memory.id}`,
        metadata: { hive_id: memory.id, hive_digest: hiveMemoryDigest(memory) },
        text: "An invented extracted claim.",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ results: hits })),
    );
    const result = await recallHiveMind(file, "How do we preserve ongoing tasks?");
    expect(result.retrieval.status).toBe("ready");
    expect(result.memories[0]?.fact).toBe(input.fact);
    await rememberHiveMind(file, { ...input, fact: "The corrected decision." });
    expect((await recallHiveMind(file, "preserve ongoing tasks")).memories).toHaveLength(0);
    await forgetHiveMind(file, memory.id);
    expect((await recallHiveMind(file, "preserve ongoing tasks")).memories).toHaveLength(0);
  });

  it("keeps local recall usable on retrieval failure and malformed responses", async () => {
    const { file } = await fixture({ hindsight });
    await rememberHiveMind(file, input);
    for (const response of [
      () => {
        throw new Error("offline");
      },
      () => Response.json({ results: "invalid" }),
      () => new Response("", { status: 503 }),
    ]) {
      vi.stubGlobal("fetch", vi.fn(response));
      const result = await recallHiveMind(file, "backend");
      expect(result.retrieval.status).toBe("degraded");
      expect(result.memories[0]?.fact).toBe(input.fact);
    }
  });
  it("keeps canonical recall available when extension configuration is corrupt", async () => {
    const { file } = await fixture();
    await rememberHiveMind(file, input);
    await NodeFSP.writeFile(hivePaths(file).config, "{broken");
    const found = await recallHiveMind(file, "backend");
    expect(found.memories[0]?.fact).toBe(input.fact);
    expect(found.retrieval.status).toBe("degraded");
    expect(await NodeFSP.readFile(hivePaths(file).config, "utf8")).toBe("{broken");
  });

  it("indexes only completed receipts, retries failed work and drains forgotten documents", async () => {
    const { file } = await fixture({ hindsight });
    const memory = await rememberHiveMind(file, input);
    let complete = false;
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ success: complete, async: false });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await syncHiveMind(file)).issues).toHaveLength(1);
    expect((await hiveMindStatus(file)).pendingIndex).toBe(1);
    complete = true;
    expect((await syncHiveMind(file)).indexed).toBe(1);
    expect((await hiveMindStatus(file)).pendingIndex).toBe(0);
    expect((await syncHiveMind(file)).indexed).toBe(0);
    await forgetHiveMind(file, memory.id);
    await syncHiveMind(file);
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) =>
          options.method === "DELETE" && String(url).endsWith(`/documents/hive-${memory.id}`),
      ),
    ).toBe(true);
    await NodeFSP.writeFile(
      hivePaths(file).config,
      JSON.stringify({ version: 1, hindsight: { ...hindsight, bank: "other-index" } }),
    );
    await rememberHiveMind(file, input);
    expect((await hiveMindStatus(file)).pendingIndex).toBe(1);
  });
});
