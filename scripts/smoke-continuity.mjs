import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startHiveMind } from "../src/service.mjs";

// Real Electron/IPC/renderer verification, always isolated from installed profiles.
process.env.HIVE_MIND_SEMANTIC = "off";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "hive-continuity-ui-"));
const stateDirectory = path.join(evidence, "data");
const token = randomBytes(32).toString("hex");
const service = await startHiveMind({ stateDirectory, token, port: 0 });
try {
  const response = await fetch(`${service.origin}/v1/assets`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Synthetic modeling reference",
      scope: "general",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0XcAAAAASUVORK5CYII=",
      source: { threadId: "synthetic-smoke", provider: "test", type: "user" },
    }),
  });
  if (!response.ok) throw new Error(`Seed failed: ${response.status}`);
} finally {
  await service.close();
}
const devExecutable =
  process.platform === "win32"
    ? path.join(root, "node_modules/electron/dist/electron.exe")
    : path.join(root, "node_modules/.bin/electron");
const env = {
  ...process.env,
  HIVE_MIND_SMOKE: "1",
  HIVE_MIND_SMOKE_PROFILE: path.join(evidence, "profile"),
  HIVE_MIND_STATE_DIR: stateDirectory,
  HIVE_MIND_PORT: "0",
  HIVE_MIND_CONNECTION_FILE: path.join(evidence, "connection.json"),
  HIVE_MIND_SMOKE_SHOT: path.join(evidence, "desktop.png"),
};
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.HIVE_MIND_SMOKE_EXECUTABLE ?? devExecutable;
if (!path.isAbsolute(executable)) throw new Error("Smoke executable must be an absolute path.");
const child = spawn(executable, process.env.HIVE_MIND_SMOKE_EXECUTABLE ? [] : [root], {
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-12000);
  });
const timer = setTimeout(() => {
  child.kill();
}, 45000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await fs.writeFile(path.join(evidence, "result.txt"), output);
  const report = output.split(/\r?\n/u).find((line) => line.startsWith("SMOKE "));
  console.log(JSON.stringify({ exitCode: code, evidence, report: report ?? output.slice(-4000) }));
  if (code !== 0 || !report) process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
