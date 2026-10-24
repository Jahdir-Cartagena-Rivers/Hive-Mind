import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
process.env.HIVE_MIND_SEMANTIC = "off";
import { startHiveMind } from "../src/service.mjs";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0XcAAAAASUVORK5CYII=";
const user = { threadId: "chat-a", provider: "test-vision", type: "user" };
const task = {
  kind: "task",
  scope: "project",
  project: "Studio",
  title: "Model a lamp",
  source: user,
  data: {
    objective: "Model the preferred lamp",
    status: "active",
    decisions: ["Use curved proportions"],
    failures: ["Thin base was unstable"],
    questions: [],
    nextSteps: ["Revise the base"],
  },
};
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-continuity-"));
  const token = randomBytes(32).toString("hex");
  const readToken = randomBytes(32).toString("hex");
  let service = await startHiveMind({ stateDirectory: dir, token, readToken, port: 0 });
  t.after(async () => {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const raw = (route, body, credential = token, extra = {}) =>
    fetch(`${service.origin}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const api = async (...args) => {
    const response = await raw(...args);
    return { status: response.status, body: await response.json() };
  };
  return {
    dir,
    token,
    readToken,
    raw,
    api,
    restart: async () => {
      await service.close();
      service = await startHiveMind({ stateDirectory: dir, token, readToken, port: 0 });
    },
  };
}
async function save(f, value) {
  const result = await f.api("/v1/brain/save", value);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
const input = (r) => ({
  id: r.id,
  revision: r.revision,
  kind: r.kind,
  scope: r.scope,
  project: r.project,
  title: r.title,
  source: r.source,
  data: r.data,
});

test("MCP preserves supplied chat provenance and rejects invalid identities before writing", async (t) => {
  const f = await fixture(t);
  const remember = (sourceThreadId) =>
    f.api("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "hive_mind_remember",
        arguments: {
          scope: "general",
          subject: "Reference provenance",
          fact: "Synthetic fact",
          sourceThreadId,
        },
      },
    });
  const invalid = await remember("unknown/client");
  assert.equal(invalid.body.result.isError, true);
  assert.equal((await f.api("/v1/status")).body.records, 0);
  const valid = await remember("chat-b:reference-1");
  assert.equal(
    JSON.parse(valid.body.result.content[0].text).memory.sourceThreadId,
    "chat-b:reference-1",
  );
});

test("two chats continue current task with corrected preferences and actual retained images after restart", async (t) => {
  const f = await fixture(t);
  const original = path.join(f.dir, "original.png");
  await fs.writeFile(original, Buffer.from(pixel, "base64"));
  const image = await f.api("/v1/assets", {
    base64: (await fs.readFile(original)).toString("base64"),
    scope: "project",
    project: "Studio",
    title: "Curved lamp reference",
    source: user,
  });
  assert.equal(image.status, 200);
  await fs.rm(original);
  const work = await save(f, task);
  const preference = await save(f, {
    kind: "preference",
    scope: "project",
    project: "Studio",
    title: "Lamp proportions",
    source: user,
    data: {
      statement: "Use a narrow base",
      polarity: "like",
      context: "Lamp modeling",
      taskId: work.id,
      assetIds: [image.body.id],
    },
  });
  const corrected = await save(f, {
    ...input(preference),
    data: { ...preference.data, statement: "Use a wide stable base" },
  });
  const foreign = await save(f, {
    kind: "preference",
    scope: "project",
    project: "Other",
    title: "Lamp rule",
    source: user,
    data: { statement: "Unrelated project rule", polarity: "constraint", context: "Other lamp" },
  });
  await f.restart();
  const packet = await f.api("/v1/working-context", {
    query: "Continue the lamp modeling references I liked",
    projects: ["New project"],
    taskId: work.id,
  });
  assert.equal(packet.status, 200);
  assert.match(packet.body.context, /wide stable base/u);
  assert.doesNotMatch(packet.body.context, /Use a narrow base|Unrelated project rule/u);
  assert.ok(packet.body.usedIds.includes(corrected.id));
  assert.ok(!packet.body.usedIds.includes(foreign.id));
  assert.equal(packet.body.assets[0].id, image.body.id);
  const bytes = await f.raw(packet.body.assets[0].path, undefined, f.readToken);
  assert.equal(bytes.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), Buffer.from(pixel, "base64"));
  const mcp = await f.api(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hive_mind_image", arguments: { action: "read", id: image.body.id } },
    },
    f.readToken,
  );
  assert.equal(mcp.body.result.content[0].type, "image");
  assert.equal(mcp.body.result.content[0].data, pixel);
});

test("idempotency, competing edits and task leases reject conflicts without duplicate work", async (t) => {
  const f = await fixture(t);
  const work = await save(f, { ...task, eventId: "start-1" });
  assert.equal((await save(f, { ...task, eventId: "start-1" })).id, work.id);
  assert.equal(
    (await f.api("/v1/brain/save", { ...task, title: "Different", eventId: "start-1" })).status,
    409,
  );
  const edits = await Promise.all(
    ["A", "B"].map((title) => f.api("/v1/brain/save", { ...input(work), title })),
  );
  assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
  const current = edits.find((r) => r.status === 200).body;
  const claim = await f.api("/v1/tasks/claim", {
    id: work.id,
    revision: current.revision,
    owner: "chat-a",
  });
  assert.equal(claim.status, 200);
  assert.equal(
    (
      await f.api("/v1/tasks/claim", {
        id: work.id,
        revision: claim.body.revision,
        owner: "chat-b",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.api("/v1/tasks/claim", {
        id: work.id,
        revision: claim.body.revision,
        owner: "chat-a",
        release: true,
      })
    ).status,
    200,
  );
});

test("committed event stream delivers new facts and replays missed events after reconnect", async (t) => {
  const f = await fixture(t);
  const response = await f.raw("/v1/events");
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: ready/u);
  const work = await save(f, task);
  const change = new TextDecoder().decode((await reader.read()).value);
  assert.match(change, new RegExp(work.id));
  await reader.cancel();
  await f.api("/v1/remember", {
    scope: "general",
    subject: "Fresh correction",
    fact: "Current value",
    sourceThreadId: "chat-a",
  });
  const changes = await f.api("/v1/changes", { after: 1 }, f.readToken);
  assert.equal(changes.body.events.length, 1);
  assert.equal(changes.body.events[0].kind, "memory.saved");
  const replay = await f.raw("/v1/events", undefined, f.readToken, { "last-event-id": "1" });
  const replayReader = replay.body.getReader();
  let received = "";
  while (!received.includes("memory.saved"))
    received += new TextDecoder().decode((await replayReader.read()).value);
  assert.match(received, /id: [a-f0-9-]+:2/u);
  assert.equal((await f.api("/v1/changes", { after: 1, streamId: "different-store" })).status, 409);
  await replayReader.cancel();
});

test("image collections keep annotations, artifact history and archive bytes; forgetting purges recall", async (t) => {
  const f = await fixture(t);
  const image = (
    await f.api("/v1/assets", { base64: pixel, scope: "general", title: "Reference", source: user })
  ).body;
  const collection = await save(f, {
    kind: "collection",
    scope: "general",
    title: "Model references",
    source: user,
    data: {
      assetIds: [image.id],
      annotations: [
        {
          assetId: image.id,
          note: "Use this silhouette",
          region: { x: 0, y: 0, width: 0.5, height: 1 },
        },
      ],
    },
  });
  const artifact = await save(f, {
    kind: "artifact",
    scope: "general",
    title: "Lamp version",
    source: user,
    data: { description: "Preferred first design", assetIds: [image.id] },
  });
  await save(f, {
    ...input(artifact),
    data: {
      ...artifact.data,
      description: "Latest second design",
      preferredRevision: artifact.revision,
    },
  });
  const archive = await f.api("/v1/archive/export", {});
  const restored = await fixture(t);
  const imported = await restored.api("/v1/archive/import", archive.body);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  await restored.restart();
  const versions = await restored.api("/v1/brain", { kind: "artifact", includeHistory: true });
  assert.equal(versions.body.records[0].history[0].data.description, "Preferred first design");
  const bytes = await restored.raw(`/v1/assets/${image.id}`);
  assert.equal(Buffer.from(await bytes.arrayBuffer()).toString("base64"), pixel);
  assert.equal((await restored.api("/v1/archive/import", archive.body)).status, 409);
  assert.equal(
    (await f.api("/v1/brain/forget", { id: image.id, revision: image.revision })).status,
    200,
  );
  assert.equal((await f.raw(`/v1/assets/${image.id}`)).status, 404);
  const remaining = await f.api("/v1/brain", { includeHistory: true });
  assert.equal(
    remaining.body.records.find((r) => r.id === collection.id).data.annotations.length,
    0,
  );
  assert.ok(!JSON.stringify(remaining.body.records).includes(image.id));
  const current = remaining.body.records.find((r) => r.id === collection.id);
  assert.equal(
    (await f.api("/v1/brain/save", { ...input(current), data: { assetIds: [image.id] } })).status,
    409,
  );
});

test("new APIs reject unauthorized writes, malformed/future state, bad references and invalid assets", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api("/v1/brain/save", task, f.readToken)).status, 403);
  assert.equal((await f.raw("/v1/events", undefined, "invalid")).status, 401);
  assert.equal(
    (await f.api("/v1/assets", { base64: "bm90IGFuIGltYWdl", scope: "general", title: "Bad" }))
      .status,
    400,
  );
  assert.equal(
    (await f.api("/v1/brain/save", { ...task, data: { ...task.data, assetIds: ["missing"] } }))
      .status,
    409,
  );
  assert.equal(
    (await f.api("/v1/brain/save", { ...task, data: { ...task.data, secretExtra: "unknown" } }))
      .status,
    400,
  );
  assert.equal((await f.api("/v1/changes", { after: 999 })).status, 409);
  const archive = await f.api("/v1/archive/export", {});
  archive.body.store.continuity = { version: 2 };
  assert.equal((await f.api("/v1/archive/import", archive.body)).status, 400);
  assert.equal((await f.api("/v1/brain", {})).body.records.length, 0);
  const bad = { version: 1, memories: [], continuity: { version: 2 } };
  const file = path.join(f.dir, "hive-mind.json");
  await fs.writeFile(file, JSON.stringify(bad));
  assert.equal((await f.api("/v1/brain/save", task)).status, 400);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), bad);
});

test("retained model files survive source removal, archive restore, and opaque MCP retrieval", async (t) => {
  const f = await fixture(t);
  const model = Buffer.from("solid synthetic-lamp\nendsolid synthetic-lamp\n");
  const imported = await f.api("/v1/files", {
    filename: "lamp.stl",
    title: "Preferred lamp model",
    scope: "general",
    source: user,
    base64: model.toString("base64"),
  });
  assert.equal(imported.status, 200);
  const asset = imported.body;
  const artifact = await save(f, {
    kind: "artifact",
    scope: "general",
    title: "Lamp model",
    source: user,
    data: { description: "Preferred model source", assetIds: [asset.id] },
  });
  const packet = await f.api("/v1/working-context", { query: "Lamp model" });
  assert.ok(packet.body.usedIds.includes(artifact.id));
  const archive = await f.api("/v1/archive/export", {});
  const other = await fixture(t);
  assert.equal((await other.api("/v1/archive/import", archive.body)).status, 200);
  const downloaded = await other.raw(`/v1/assets/${asset.id}`);
  assert.equal(downloaded.headers.get("content-disposition"), "attachment");
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), model);
  const mcp = await other.api(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hive_mind_file", arguments: { action: "read", id: asset.id } },
    },
    other.readToken,
  );
  assert.equal(mcp.body.result.content[0].resource.blob, model.toString("base64"));
});

test("perceptual matching is scoped and does not invent a preference; context is budgeted", async (t) => {
  const f = await fixture(t);
  const descriptor = { algorithm: "hive-perceptual-v1", values: Array(256).fill(0) };
  const a = (
    await f.api("/v1/assets", {
      base64: pixel,
      scope: "project",
      project: "Studio",
      title: "Reference A",
      source: user,
      descriptor,
    })
  ).body;
  const b = (
    await f.api("/v1/assets", {
      base64: Buffer.concat([Buffer.from(pixel, "base64"), Buffer.from([0])]).toString("base64"),
      scope: "project",
      project: "Studio",
      title: "Reference B",
      source: user,
      descriptor: { ...descriptor, values: Array(256).fill(0.1) },
    })
  ).body;
  await f.api("/v1/assets", {
    base64: pixel,
    scope: "project",
    project: "Other",
    title: "Foreign reference",
    source: user,
    descriptor,
  });
  const result = await f.api("/v1/visual-search", { assetId: a.id });
  assert.equal(result.body.matches[0].record.id, b.id);
  assert.equal(result.body.matches.length, 1);
  assert.match(result.body.note, /does not establish/u);
  const packet = await f.api("/v1/working-context", {
    query: "Reference",
    projects: ["Studio"],
    maxChars: 1000,
  });
  assert.ok(packet.body.context.length <= 1000);
  assert.equal(
    (
      await f.api("/v1/assets", {
        base64: pixel,
        scope: "general",
        title: "Invalid descriptor",
        descriptor: { ...descriptor, values: [Infinity] },
      })
    ).status,
    400,
  );
});

test("single state owner rejects concurrent services and recovers a terminated process", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    startHiveMind({ stateDirectory: f.dir, token: f.token, port: 0 }),
    /running Hive Mind owner/u,
  );
  assert.equal((await f.api("/v1/brain", {})).status, 200);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-crash-recovery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const code = `import { startHiveMind } from ${JSON.stringify(new URL("../src/service.mjs", import.meta.url).href)}; const service = await startHiveMind({stateDirectory:${JSON.stringify(directory)},token:${JSON.stringify(f.token)},port:0}); await fetch(service.origin+'/v1/remember',{method:'POST',headers:{authorization:'Bearer '+${JSON.stringify(f.token)},'content-type':'application/json'},body:JSON.stringify({scope:'general',subject:'Durable before crash',fact:'Saved'})}); process.exit(0);`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, HIVE_MIND_SEMANTIC: "off" },
  });
  const recovered = await startHiveMind({ stateDirectory: directory, token: f.token, port: 0 });
  try {
    const response = await fetch(`${recovered.origin}/v1/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "Durable" }),
    });
    assert.equal((await response.json()).memories[0].fact, "Saved");
  } finally {
    await recovered.close();
  }
});

test("preferred artifact history preserves provenance and cannot expose a narrower project", async (t) => {
  const f = await fixture(t);
  const image = (
    await f.api("/v1/assets", {
      base64: pixel,
      scope: "project",
      project: "Studio",
      title: "Private reference",
      source: user,
    })
  ).body;
  const artifact = await save(f, {
    kind: "artifact",
    scope: "project",
    project: "Studio",
    title: "Model",
    source: user,
    data: { description: "User-preferred original", assetIds: [image.id] },
  });
  const latest = await save(f, {
    ...input(artifact),
    source: { threadId: "chat-b", provider: "other", type: "agent" },
    data: { description: "Later version", assetIds: [], preferredRevision: artifact.revision },
  });
  assert.equal(latest.history[0].source.threadId, user.threadId);
  assert.equal(latest.history[0].source.type, "user");
  assert.equal(
    (await f.api("/v1/brain/save", { ...input(latest), scope: "general", project: undefined }))
      .status,
    409,
  );
  const packet = await f.api("/v1/working-context", { query: "Model", projects: ["Studio"] });
  assert.match(packet.body.context, /User-preferred original/u);
  assert.equal(packet.body.assets[0].id, image.id);
  assert.equal(
    (await f.api("/v1/brain/forget", { id: image.id, revision: image.revision })).status,
    200,
  );
  const history = (await f.api("/v1/brain", { id: artifact.id, includeHistory: true })).body
    .records[0].history;
  assert.equal(history[0].redacted, true);
});

test("a clear continuation discovers its task across chats without importing unrelated project instructions", async (t) => {
  const f = await fixture(t);
  const lamp = await save(f, task);
  await save(f, {
    ...task,
    project: "Other",
    title: "Robot firmware",
    data: {
      ...task.data,
      objective: "Maintain robot firmware",
      decisions: ["Unrelated robot instructions"],
    },
  });
  const cross = await f.api("/v1/working-context", {
    query: "Continue the lamp model",
    projects: ["New surface"],
  });
  assert.equal(cross.body.taskId, lamp.id);
  assert.equal(cross.body.diagnostics.taskSelection, "unambiguous-continuation");
  assert.match(cross.body.context, /curved proportions/u);
  assert.doesNotMatch(cross.body.context, /Unrelated robot instructions/u);
  assert.equal(
    (await f.api("/v1/working-context", { query: "Hello", projects: ["New surface"] })).body.taskId,
    null,
  );
  assert.equal(
    (await f.api("/v1/working-context", { query: "Continue", projects: ["Studio"] })).body.taskId,
    lamp.id,
  );
  await save(f, {
    ...task,
    title: "Second lamp",
    data: { ...task.data, objective: "Build another lamp" },
  });
  const ambiguous = await f.api("/v1/working-context", {
    query: "Continue the lamp",
    projects: ["Studio"],
  });
  assert.equal(ambiguous.body.taskId, null);
  assert.equal(ambiguous.body.diagnostics.taskSelection, "ambiguous");
});

test("large task state is explicitly abbreviated in working memory and remains fully retrievable", async (t) => {
  const f = await fixture(t);
  const large = await save(f, {
    ...task,
    data: {
      ...task.data,
      objective: "lamp ".repeat(600),
      decisions: Array(20).fill("d".repeat(200)),
      nextSteps: Array(20).fill("n".repeat(200)),
    },
  });
  const packet = await f.api("/v1/working-context", {
    taskId: large.id,
    query: "Continue",
    maxChars: 1000,
  });
  assert.ok(packet.body.context.length <= 1000);
  assert.equal(packet.body.diagnostics.taskStateIncluded, true);
  assert.match(packet.body.context, /"truncated":true/u);
  assert.equal(
    (await f.api("/v1/brain", { id: large.id })).body.records[0].data.decisions.length,
    20,
  );
});

test("long chats keep current freshness without exhausting history and retain separate per-turn delivery evidence", async (t) => {
  const f = await fixture(t);
  let client;
  for (let i = 0; i < 105; i++)
    client = await save(f, {
      kind: "client",
      scope: "general",
      title: "Chat freshness",
      source: user,
      data: { consumedSequence: i, deliveredIds: [], usedIds: [] },
      ...(client ? { id: client.id, revision: client.revision } : {}),
    });
  assert.equal(client.history.length, 0);
  const episode = await save(f, {
    kind: "episode",
    scope: "general",
    title: "Context delivery",
    source: { ...user, type: "agent" },
    data: {
      summary: "A provider received the task context",
      eventId: "delivery-105",
      contextSequence: 105,
      deliveredIds: [],
    },
    eventId: "delivery-105",
  });
  await f.restart();
  assert.equal(
    (await f.api("/v1/brain", { id: episode.id })).body.records[0].data.contextSequence,
    105,
  );
});
