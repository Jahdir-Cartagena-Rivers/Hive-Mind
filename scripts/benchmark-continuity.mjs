import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { startHiveMind } from "../src/service.mjs";
import { mutateHiveStore } from "../src/core/store.ts";
import { fingerprint } from "../src/core/continuity.ts";

process.env.HIVE_MIND_SEMANTIC = "off";
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "hive-continuity-benchmark-"));
const stateDirectory = path.join(evidence, "data");
const token = randomBytes(32).toString("hex");
const service = await startHiveMind({ stateDirectory, token, port: 0 });
const source = { threadId: "synthetic-benchmark", provider: "test", type: "user" };
const api = async (route, body) => {
  const response = await fetch(`${service.origin}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status}`);
  return value;
};
let reader;
try {
  const at = new Date().toISOString();
  const records = Array.from({ length: 1000 }, (_, i) => {
    const body = {
      kind: "task",
      scope: "project",
      project: "Synthetic",
      title: `Synthetic task ${i}`,
      source,
      data: {
        objective: "Synthetic modeling objective",
        status: "active",
        nextSteps: ["Revise the base"],
      },
    };
    return {
      ...body,
      id: `bench-${i}`,
      revision: fingerprint(body),
      createdAt: at,
      updatedAt: at,
      history: [],
    };
  });
  await mutateHiveStore(path.join(stateDirectory, "hive-mind.json"), (store) => [
    { ...store, continuity: { ...store.continuity, records } },
    undefined,
  ]);
  const stream = await fetch(`${service.origin}/v1/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!stream.ok) throw new Error("Subscription failed.");
  reader = stream.body.getReader();
  await reader.read(); // Ready receipt, before any measurement starts.
  let record = records[0];
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const begin = performance.now();
    record = await api("/v1/brain/save", {
      id: record.id,
      revision: record.revision,
      kind: record.kind,
      scope: record.scope,
      project: record.project,
      title: record.title,
      source,
      data: { ...record.data, objective: `Current modeling correction ${i}` },
    });
    const committed = performance.now();
    let receipt = "";
    while (!receipt.includes('"id":"bench-0"')) {
      const next = await reader.read();
      if (next.done) throw new Error("Subscription ended before the commit receipt.");
      receipt += new TextDecoder().decode(next.value);
    }
    const delivered = performance.now();
    const packet = await api("/v1/working-context", {
      taskId: record.id,
      query: "Continue modeling",
      projects: ["Synthetic"],
    });
    if (!packet.context.includes(`Current modeling correction ${i}`))
      throw new Error("Context missed the acknowledged correction.");
    const assembled = performance.now();
    samples.push({
      saveMs: committed - begin,
      deliveryFromSaveMs: delivered - begin,
      contextMs: assembled - delivered,
      totalMs: assembled - begin,
    });
  }
  const percentile = (key, p) =>
    [...samples].map((s) => s[key]).sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1];
  const result = {
    records: 1000,
    samples: samples.length,
    semanticIndex: "disabled; measures canonical commit, event delivery and context only",
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0]?.model,
    timings: Object.fromEntries(
      Object.keys(samples[0]).map((key) => [
        key,
        { p50: +percentile(key, 0.5).toFixed(2), p95: +percentile(key, 0.95).toFixed(2) },
      ]),
    ),
  };
  await fs.writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify({ ...result, samples }, null, 2),
  );
  console.log(JSON.stringify({ ...result, evidence }));
} finally {
  await reader?.cancel();
  await service.close();
}
