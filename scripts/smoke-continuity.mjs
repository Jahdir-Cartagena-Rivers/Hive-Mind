import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { startHiveMind } from "../src/service.mjs";

// Real Electron/IPC/renderer verification, always isolated from installed profiles.
process.env.HIVE_MIND_SEMANTIC = "off";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "hive-continuity-ui-"));
const stateDirectory = path.join(evidence, "data");
const token = randomBytes(32).toString("hex");
const service = await startHiveMind({ stateDirectory, token, port: 0 });
// A valid synthetic RGBA reference (not a user's file); both Chromium and the
// native image decoder must be able to render it and its thumbnail.
function referencePng() {
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      contents = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of contents) {
      crc ^= byte;
      for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    name.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
    return out;
  };
  const width = 320,
    height = 200,
    header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 4 + 1) + 1 + x * 4;
      const lamp =
        (y > 45 && y < 100 && Math.abs(x - 160) < (y - 35) * 0.7) ||
        (y >= 100 && y < 155 && Math.abs(x - 160) < 5) ||
        (y >= 155 && y < 167 && Math.abs(x - 160) < 48);
      pixels[at] = lamp ? 220 : 28 + Math.floor(y / 15);
      pixels[at + 1] = lamp ? 175 : 35;
      pixels[at + 2] = lamp ? 105 : 58;
      pixels[at + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
try {
  for (const [project, subjects] of [
    [
      "Modeling studio",
      [
        "Sculpting references",
        "Silhouette studies",
        "Material palette",
        "Preferred proportions",
        "Version to revisit",
        "Lighting notes",
        "Surface finish",
        "Character details",
      ],
    ],
    [
      "Creative projects",
      [
        "Ideas to explore",
        "Color experiments",
        "Composition notes",
        "A promising direction",
        "Favorite draft",
        "Reference library",
      ],
    ],
    [
      "Workbench",
      [
        "Current milestone",
        "Useful discoveries",
        "Next steps",
        "Lessons learned",
        "Design decisions",
        "Open questions",
      ],
    ],
  ])
    for (const subject of subjects) {
      const response = await fetch(`${service.origin}/v1/remember`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          scope: "project",
          project,
          subject,
          fact: "Synthetic desktop verification memory. Use this reference to continue the example design.",
        }),
      });
      if (!response.ok) throw new Error(`Memory seed failed: ${response.status}`);
    }
  const response = await fetch(`${service.origin}/v1/assets`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Synthetic modeling reference",
      scope: "general",
      base64: referencePng(),
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
if (process.env.HIVE_MIND_SMOKE_DRIVE === '1') {
  await fs.mkdir(env.HIVE_MIND_SMOKE_PROFILE, { recursive: true });
  // Deliberately absent protected key: exercise the actual packaged worker and safe offline UI without any network call.
  await fs.writeFile(path.join(env.HIVE_MIND_SMOKE_PROFILE, 'drive-sync.json'), JSON.stringify({ version: 1, enabled: true,
    workspace: 'synthetic-desktop-drive', client: 'desktop-smoke', bootstrap: 'join',
    protectedKeyFile: path.join(evidence, 'intentionally-missing.protected.json'), transportOptions: {
      folderId: 'synthetic_folder_12345', fileId: 'synthetic_file_12345', expectedName: 'synthetic.enc',
      userId: 'synthetic-user', connectedAccountId: 'synthetic_account_123' } }));
}
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
