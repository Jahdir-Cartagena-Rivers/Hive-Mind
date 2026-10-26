// Exercise the actual J1 reporter against the actual Hive service with two concurrent
// chats. Run: node scripts/test-j1-presence.mjs <path-to-J1_Code>
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { startHiveMind } from "../src/service.mjs";

if (!process.argv[2]) throw new Error("Pass the J1 source checkout to test.");
const { LivePresence } = await import(
  pathToFileURL(path.resolve(process.argv[2], "apps/server/src/hiveMind/livePresence.ts")).href
);
process.env.HIVE_MIND_SEMANTIC = "off";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-j1-presence-"));
const token = randomBytes(32).toString("hex");
const service = await startHiveMind({
  stateDirectory: path.join(directory, "state"),
  token,
  port: 0,
});
const controller = new AbortController();
try {
  const api = async (route, body) => {
    const response = await fetch(`${service.origin}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const stream = await fetch(`${service.origin}/v1/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let streamed = "";
  const until = async (text) => {
    while (!streamed.includes(text)) {
      const { value, done } = await reader.read();
      assert.equal(done, false, "event stream ended early");
      streamed += decoder.decode(value, { stream: true });
    }
  };
  const timeout = setTimeout(() => controller.abort(), 20_000);
  timeout.unref();
  try {
    await until("event: presence");
    const sequence = (await api("/v1/changes", {})).sequence;
    const task = await api("/v1/brain/save", {
      kind: "task",
      scope: "project",
      project: "Presence Studio",
      title: "Lamp model",
      source: { threadId: "test-chat-a", provider: "test", type: "user" },
      data: {
        objective: "Model a lamp",
        status: "active",
        decisions: [],
        failures: [],
        questions: [],
        nextSteps: [],
      },
    });
    const afterTask = (await api("/v1/changes", {})).sequence;
    assert.ok(afterTask > sequence);
    let clock = Date.now();
    const errors = [];
    const send = (_connection, body) => api("/v1/presence", body);
    const a = new LivePresence(
      send,
      () => clock,
      (error) => errors.push(error),
    );
    const b = new LivePresence(
      send,
      () => clock,
      (error) => errors.push(error),
    );
    const target = { connection: "test", project: "Presence Studio", taskId: task.id };
    a.begin("test-chat-a", { ...target, provider: "codex", title: "Modeling chat" });
    b.begin("test-chat-b", { ...target, provider: "claudeAgent", title: "Reference chat" });
    await Promise.all([a.flush(), b.flush()]);
    await until('"overlap":true');
    const context = await api("/v1/working-context", {
      query: "Continue the lamp",
      projects: [target.project],
      threadId: "test-chat-b",
      taskId: task.id,
    });
    assert.match(context.context, /Modeling chat/u);
    assert.match(context.context, /ALSO WORKING ON THE SAME TASK/u);
    assert.doesNotMatch(context.context, /Reference chat/u);
    clock += 2_000;
    a.observe("test-chat-a", {
      type: "item.started",
      payload: {
        itemType: "file_change",
        detail: "private-file-path",
        command: "private-command",
      },
    });
    b.observe("test-chat-b", { type: "request.opened" });
    await Promise.all([a.flush(), b.flush()]);
    await until('"step":"editing files"');
    await until('"status":"waiting"');
    assert.doesNotMatch(streamed, /private-file-path|private-command/u);
    const unrelated = await api("/v1/working-context", {
      query: "hello",
      projects: ["Unrelated"],
      threadId: "test-chat-c",
    });
    assert.doesNotMatch(unrelated.context, /Modeling chat|Reference chat/u);
    clock += 31_000;
    a.heartbeat();
    await a.flush();
    a.finish("test-chat-a");
    b.end("test-chat-b");
    await Promise.all([a.flush(), b.flush()]);
    const final = await api("/v1/presence/list", {});
    assert.equal(final.presence.length, 1);
    assert.equal(final.presence[0].status, "idle");
    assert.equal(final.presence[0].overlap, false);
    assert.equal((await api("/v1/changes", {})).sequence, afterTask);
    assert.deepEqual(errors, []);
    const report = {
      passed: true,
      chats: 2,
      checks: [
        "SSE",
        "context",
        "overlap",
        "steps",
        "waiting",
        "scope",
        "heartbeat",
        "idle",
        "end",
        "no durable heartbeat writes",
      ],
      evidence: directory,
    };
    await fs.writeFile(path.join(directory, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
} finally {
  controller.abort();
  await service.close();
}
