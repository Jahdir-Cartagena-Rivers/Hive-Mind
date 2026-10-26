import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
process.env.HIVE_MIND_SEMANTIC = "off";
import { startHiveMind } from "../src/service.mjs";
import { createPresence } from "../src/presence.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-presence-"));
  const token = randomBytes(32).toString("hex");
  const readToken = randomBytes(32).toString("hex");
  const service = await startHiveMind({ stateDirectory: dir, token, readToken, port: 0 });
  t.after(async () => {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const api = async (route, body, credential = token) => {
    const response = await fetch(`${service.origin}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { service, token, readToken, api };
}
const report = (f, chatId, extra = {}) =>
  f.api("/v1/presence", { chatId, provider: "test", status: "working", step: "editing files", ...extra });

test("another chat sees live work in its next context, never its own, without touching durable state", async (t) => {
  const f = await fixture(t);
  const before = (await f.api("/v1/changes", {})).body.sequence;
  assert.equal((await report(f, "chat-a", { title: "Lamp model", project: "Studio" })).status, 200);
  const seenByB = await f.api("/v1/working-context", {
    query: "hello",
    projects: ["Studio"],
    threadId: "chat-b",
  });
  assert.match(seenByB.body.context, /Other chats right now/u);
  assert.match(seenByB.body.context, /Lamp model \(test, Studio\): working — editing files/u);
  assert.equal(seenByB.body.diagnostics.activeChats, 1);
  const seenByA = await f.api("/v1/working-context", { query: "hello", projects: ["Studio"], threadId: "chat-a" });
  assert.doesNotMatch(seenByA.body.context, /Other chats right now/u);
  assert.equal((await f.api("/v1/changes", {})).body.sequence, before, "heartbeats must not write durable events");
});

test("project-scoped activity stays out of unrelated projects", async (t) => {
  const f = await fixture(t);
  await report(f, "secret-chat", { project: "Private" });
  await report(f, "open-chat");
  const other = await f.api("/v1/working-context", { query: "x", projects: ["Studio"], threadId: "c" });
  assert.doesNotMatch(other.body.context, /secret-chat/u);
  assert.match(other.body.context, /open-chat/u);
  const listed = await f.api("/v1/presence/list", { projects: ["Studio"] }, f.readToken);
  assert.deepEqual(listed.body.presence.map((e) => e.chatId), ["open-chat"]);
});

test("two chats working on one task are flagged to each other", async (t) => {
  const f = await fixture(t);
  const task = (
    await f.api("/v1/brain/save", {
      kind: "task",
      scope: "project",
      project: "Studio",
      title: "Model a lamp",
      source: { threadId: "chat-a", provider: "test", type: "user" },
      data: { objective: "Model the lamp", status: "active", decisions: [], failures: [], questions: [], nextSteps: [] },
    })
  ).body;
  await report(f, "chat-a", { taskId: task.id, project: "Studio" });
  const second = await report(f, "chat-b", { taskId: task.id, project: "Studio" });
  assert.equal(second.body.presence.overlap, true);
  assert.deepEqual(second.body.presence.sharesTaskWith, ["chat-a"]);
  const context = await f.api("/v1/working-context", { query: "x", taskId: task.id, threadId: "chat-b" });
  assert.match(context.body.context, /ALSO WORKING ON THE SAME TASK/u);
  // A chat that merely finished is not a conflict.
  await report(f, "chat-a", { taskId: task.id, project: "Studio", status: "idle", step: "" });
  const after = await f.api("/v1/presence/list", {}, f.readToken);
  assert.equal(after.body.presence.find((e) => e.chatId === "chat-b").overlap, false);
});

test("read tokens can look but not report; bad input is rejected; text is sanitized", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api("/v1/presence", { chatId: "x", provider: "t" }, f.readToken)).status, 403);
  assert.equal((await f.api("/v1/presence", { chatId: "bad id!", provider: "t" })).status, 400);
  assert.equal((await f.api("/v1/presence", { chatId: "x", provider: "t", status: "sleeping" })).status, 400);
  const ok = await report(f, "x", { step: `line\u0000one\n\ntwo ${"y".repeat(400)}` });
  assert.match(ok.body.presence.step, /^line one two y+$/u);
  assert.ok(ok.body.presence.step.length <= 160);
  const ended = await f.api("/v1/presence", { action: "end", chatId: "x" });
  assert.equal(ended.body.ended, true);
  assert.deepEqual((await f.api("/v1/presence/list", {}, f.readToken)).body.presence, []);
});

test("MCP agents can report and read activity", async (t) => {
  const f = await fixture(t);
  const call = async (args, credential = f.token) =>
    (
      await f.api(
        "/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hive_mind_presence", arguments: args } },
        credential,
      )
    ).body.result;
  assert.ok(!(await call({ action: "update", chatId: "codex-1", provider: "codex", step: "running tests" })).isError);
  const seen = JSON.parse((await call({ action: "list" }, f.readToken)).content[0].text);
  assert.equal(seen.presence[0].step, "running tests");
  assert.equal((await call({ action: "update", chatId: "z", provider: "p" }, f.readToken)).isError, true);
});

test("live stream pushes presence changes as they happen", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${f.service.origin}/v1/events`, {
    headers: { authorization: `Bearer ${f.readToken}` },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const until = async (pattern) => {
    const deadline = Date.now() + 5000;
    while (!pattern.test(text)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}\n${text}`);
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
  };
  await until(/event: presence/u);
  await report(f, "chat-live", { step: "writing a reply" });
  await until(/"step":"writing a reply"/u);
  // A repeated heartbeat is silent; only a real change emits again.
  await report(f, "chat-live", { step: "writing a reply" });
  await report(f, "chat-live", { step: "running a command" });
  await until(/"step":"running a command"/u);
  assert.equal(text.match(/"step":"writing a reply"/gu).length, 1);
});

test("entries expire without heartbeats; finished chats linger as idle", () => {
  let clock = 1_000_000;
  const p = createPresence({ now: () => clock });
  p.update({ chatId: "a", provider: "x", status: "working", step: "s" });
  p.update({ chatId: "b", provider: "x", status: "idle" });
  clock += 119_000;
  assert.equal(p.list().length, 2);
  clock += 2_000;
  assert.deepEqual(p.list().map((e) => e.chatId), ["b"]);
  clock += 600_000;
  assert.deepEqual(p.list(), []);
});
