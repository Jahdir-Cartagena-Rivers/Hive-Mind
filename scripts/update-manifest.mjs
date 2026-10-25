import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("A stable release version is required.");
const filename = `Hive-Mind-Setup-${version}-x64.exe`;
const file = path.join(root, "dist", filename);
const hash = createHash("sha256");
for await (const chunk of createReadStream(file)) hash.update(chunk);
const manifest = {
  version,
  filename,
  url: `https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind/releases/download/v${version}/${filename}`,
  sha256: hash.digest("hex"),
  size: (await fs.stat(file)).size,
};
await fs.writeFile(
  path.join(root, "dist", "hive-mind-update.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`Created update manifest for ${filename}`);
