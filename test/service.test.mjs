import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { startHiveMind, validateStateDirectory } from "../src/service.mjs";

const fact = {
  scope: "project",
  project: "Nebula",
  subject: "Cooling material",
  fact: "Copper fins dissipate heat.",
};
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-standalone-"));
  const token = randomBytes(32).toString("hex");
  const readToken = randomBytes(32).toString("hex");
  let service = await startHiveMind({ stateDirectory: directory, token, readToken, port: 0 });
  t.after(async () => {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    token,
    readToken,
    async restart() {
      await service.close();
      service = await startHiveMind({ stateDirectory: directory, token, readToken, port: 0 });
    },
    async request(route, body, credential = token, extraHeaders = {}) {
      const response = await fetch(`${service.origin}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      });
      return {
        status: response.status,
        value: await response.json(),
        cache: response.headers.get("cache-control"),
      };
    },
  };
}

test("authentication and read-only tokens reject writes before touching memory", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/health", undefined, null)).status, 200);
  assert.equal((await f.request("/v1/status", undefined, null)).status, 401);
  assert.equal((await f.request("/v1/remember", fact, "invalid")).status, 401);
  assert.equal((await f.request("/v1/remember", fact, f.readToken)).status, 403);
  const status = await f.request("/v1/status", undefined, f.readToken);
  assert.equal(status.status, 200);
  assert.equal(status.value.records, 0);
  assert.equal(status.cache, "no-store");
  assert.equal((await f.request("/v1/search", { query: "cooling" }, f.readToken)).status, 200);
  assert.equal((await f.request("/v1/configure", { version: 1 }, f.readToken)).status, 403);
});

test("malformed JSON, invalid fields, browser origins, unsupported routes and oversized bodies preserve data", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/v1/remember", "{bad")).status, 400);
  assert.equal((await f.request("/v1/remember", { scope: "unexpected" })).status, 400);
  assert.equal(
    (await f.request("/v1/remember", fact, f.token, { origin: "https://example.invalid" })).status,
    403,
  );
  assert.equal(
    (await f.request("/v1/remember", fact, f.token, { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal((await f.request("/v1/unknown", {})).status, 404);
  assert.equal((await f.request("/v1/remember?token=redacted", fact)).status, 400);
  assert.equal((await f.request("/v1/remember", { ...fact, fact: "x".repeat(70000) })).status, 413);
  assert.equal((await f.request("/v1/status")).value.records, 0);
});

test("remember, correction conflict, restart and forgetting use current authoritative revisions", async (t) => {
  const f = await fixture(t);
  const remembered = await f.request("/v1/remember", fact);
  assert.equal(remembered.status, 200);
  const { id, revision } = remembered.value.memory;
  const edit = { id, revision, fact: "Aluminum fins dissipate heat." };
  assert.equal((await f.request("/v1/edit", edit)).status, 200);
  assert.equal((await f.request("/v1/edit", { ...edit, fact: "Stale correction." })).status, 409);
  await f.restart();
  const recall = await f.request("/v1/search", { query: "cooling", project: "Nebula" });
  assert.equal(recall.value.memories.length, 1);
  assert.equal(recall.value.memories[0].fact, edit.fact);
  assert.notEqual(recall.value.memories[0].revision, revision);
  assert.equal((await f.request("/v1/forget", { id })).value.removed, true);
  await f.restart();
  assert.equal((await f.request("/v1/search", { query: "cooling" })).value.memories.length, 0);
  assert.equal((await f.request("/v1/edit", edit)).status, 409);
});

test("vault synchronization and pause/configure round trip in isolated state", async (t) => {
  const f = await fixture(t);
  const vault = path.join(f.directory, "vault");
  assert.equal(
    (await f.request("/v1/configure", { version: 1, automatic: false, vault })).status,
    200,
  );
  await f.request("/v1/remember", fact);
  const sync = await f.request("/v1/sync", {});
  assert.equal(sync.status, 200);
  const status = await f.request("/v1/status");
  assert.equal(status.value.config.automatic, false);
  assert.equal(status.value.phase, "paused");
  assert.equal(status.value.records, 1);
  assert.ok((await fs.readdir(path.join(vault, "Hive Mind"))).some((file) => file.endsWith(".md")));
});

test("state validation refuses installed profiles, databases, relative paths and symlink ancestors", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-state-guards-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(validateStateDirectory("relative-directory"));
  await assert.rejects(validateStateDirectory(path.join(directory, ".j1", "userdata")));
  await assert.rejects(validateStateDirectory(path.join(directory, ".t3", "dev")));
  await fs.writeFile(path.join(directory, "state.sqlite"), "synthetic marker");
  await assert.rejects(validateStateDirectory(directory));
  assert.equal(await fs.readFile(path.join(directory, "state.sqlite"), "utf8"), "synthetic marker");
  const real = path.join(directory, "dedicated");
  const link = path.join(directory, "alias");
  await fs.mkdir(real);
  await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(validateStateDirectory(path.join(link, "child")));
  if (process.platform !== "win32") {
    await fs.symlink(path.join(directory, "state.sqlite"), path.join(real, "hive-mind.json"));
    await assert.rejects(validateStateDirectory(real));
  }
  await assert.rejects(startHiveMind({ stateDirectory: real, token: "weak", port: 0 }));
});

test("malformed existing state is rejected without overwriting the file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-malformed-state-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "hive-mind.json");
  await fs.writeFile(file, "{malformed");
  await assert.rejects(
    startHiveMind({ stateDirectory: directory, token: randomBytes(32).toString("hex"), port: 0 }),
  );
  assert.equal(await fs.readFile(file, "utf8"), "{malformed");
});
