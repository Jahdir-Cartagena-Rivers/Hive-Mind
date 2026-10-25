import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  createUpdater,
  isNewer,
  validateManifest,
  launchInstaller,
  RELEASES,
} from "../app/updater.mjs";

const bytes = Buffer.from("synthetic installer fixture, never executed");
const manifest = {
  version: "0.4.0",
  filename: "Hive-Mind-Setup-0.4.0-x64.exe",
  url: "https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind/releases/download/v0.4.0/Hive-Mind-Setup-0.4.0-x64.exe",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
};
const metadataUrl =
  "https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind/releases/download/v0.4.0/hive-mind-update.json";
async function fixture(t, transform = (value) => value) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-updater-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const updater = createUpdater({
    version: "0.3.0",
    directory,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === RELEASES)
        return Response.json({
          tag_name: "v0.4.0",
          assets: [{ name: "hive-mind-update.json", browser_download_url: metadataUrl }],
        });
      if (url === metadataUrl) return Response.json(transform({ ...manifest }));
      return new Response(bytes);
    },
  });
  return { updater, calls, directory };
}
test("stable versions compare numerically and manifests bind version, host, path, size and digest", () => {
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.4.0", "0.4.0"), false);
  assert.equal(isNewer("0.3.9", "0.4.0"), false);
  assert.throws(() => isNewer("0.4.0-beta", "0.3.0"));
  for (const altered of [
    { url: "https://example.invalid/update.exe" },
    { filename: "../other.exe" },
    { size: -1 },
    { sha256: "bad" },
  ])
    assert.throws(() => validateManifest({ ...manifest, ...altered }, "v0.4.0"));
});
test("concurrent checks share one download and verified cached artifacts are reused", async (t) => {
  const { updater, calls } = await fixture(t);
  await Promise.all([updater.check(), updater.check()]);
  assert.equal(updater.state.phase, "ready");
  const file = await updater.prepareInstall();
  assert.deepEqual(await fs.readFile(file), bytes);
  await updater.check();
  assert.equal(calls.filter((url) => url === manifest.url).length, 1);
  await fs.writeFile(file, Buffer.from("tampered"));
  await assert.rejects(updater.prepareInstall(), /size|checksum/u);
});
test("checksum mismatch and truncated payload never become installable", async (t) => {
  for (const transform of [
    (value) => ({ ...value, sha256: "0".repeat(64) }),
    (value) => ({ ...value, size: value.size + 1 }),
  ]) {
    const { updater } = await fixture(t, transform);
    assert.equal((await updater.check()).phase, "error");
    await assert.rejects(updater.prepareInstall(), /No verified/u);
  }
});
test("a failed check can retry and older releases never trigger a download", async () => {
  let fail = true,
    downloads = 0;
  const updater = createUpdater({
    version: "0.4.0",
    directory: "unused",
    fetchImpl: async () => {
      if (fail) throw new Error("offline");
      downloads++;
      return Response.json({ tag_name: "v0.3.0" });
    },
  });
  assert.equal((await updater.check()).phase, "error");
  fail = false;
  assert.equal((await updater.check()).phase, "current");
  assert.equal(downloads, 1);
});
test("installer launch is detached, shell-free, hidden and does not execute during tests", async () => {
  let actual;
  await launchInstaller("fixture.exe", (...args) => {
    actual = args;
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  assert.deepEqual(actual[1], ["/S", "--updated", "--force-run"]);
  assert.equal(actual[2].shell, false);
  assert.equal(actual[2].windowsHide, true);
});
