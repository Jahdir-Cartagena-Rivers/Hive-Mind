import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

export const RELEASES =
  "https://api.github.com/repos/Jahdir-Cartagena-Rivers/Hive-Mind/releases/latest";
const PREFIX = "https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind/releases/download/";
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

function versionParts(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version))
    throw new Error("Invalid update version.");
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("Invalid update version.");
  return parts;
}
export function isNewer(candidate, current) {
  const a = versionParts(candidate),
    b = versionParts(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
export function validateManifest(value, tag) {
  versionParts(value?.version);
  const filename = `Hive-Mind-Setup-${value.version}-x64.exe`;
  if (
    tag !== `v${value.version}` ||
    value.filename !== filename ||
    value.url !== `${PREFIX}${tag}/${filename}` ||
    !/^[a-f0-9]{64}$/u.test(value.sha256 ?? "") ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_INSTALLER_BYTES
  ) {
    throw new Error("Invalid update manifest.");
  }
  return {
    version: value.version,
    filename,
    url: value.url,
    sha256: value.sha256,
    size: value.size,
  };
}
async function jsonResponse(response) {
  if (!response.ok) throw new Error(`Update server returned HTTP ${response.status}.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error("Update metadata is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function verifyInstaller(file, manifest) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.size)
    throw new Error("Update size does not match.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== manifest.sha256) throw new Error("Update checksum does not match.");
}

/** Network and file preparation only: installing is a separate explicit tray action. */
export function createUpdater({ version, directory, fetchImpl = fetch, onChange = () => {} }) {
  let state = { phase: "idle", version };
  let running;
  let downloaded;
  const publish = (next) => {
    state = { version, ...next };
    onChange(state);
  };
  const request = (url) =>
    fetchImpl(url, {
      headers: { "user-agent": "Hive-Mind-Updater" },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  async function prepare() {
    publish({ phase: "checking" });
    const release = await jsonResponse(await request(RELEASES));
    if (release.draft || release.prerelease) throw new Error("Update release is not stable.");
    const asset = release.assets?.find((item) => item.name === "hive-mind-update.json");
    const tag = release.tag_name;
    if (!/^v\d+\.\d+\.\d+$/u.test(tag ?? "")) throw new Error("Invalid release tag.");
    if (!isNewer(tag.slice(1), version)) {
      publish({ phase: "current" });
      return state;
    }
    if (asset?.browser_download_url !== `${PREFIX}${tag}/hive-mind-update.json`)
      throw new Error("Release has no verified update manifest.");
    const manifest = validateManifest(
      await jsonResponse(await request(asset.browser_download_url)),
      tag,
    );
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.lstat(directory)).isSymbolicLink())
      throw new Error("Update directory cannot be a link.");
    const file = path.join(directory, manifest.filename);
    try {
      await verifyInstaller(file, manifest);
    } catch {
      publish({ phase: "downloading", nextVersion: manifest.version, percent: 0 });
      const response = await request(manifest.url);
      if (!response.ok || !response.body)
        throw new Error(`Update download returned HTTP ${response.status}.`);
      const pending = `${file}.${randomUUID()}.part`;
      const handle = await fs.open(pending, "wx");
      const hash = createHash("sha256");
      let size = 0,
        lastPercent = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > manifest.size) throw new Error("Update download exceeds its declared size.");
          hash.update(chunk);
          await handle.writeFile(chunk);
          const percent = Math.floor((size / manifest.size) * 20) * 5;
          if (percent > lastPercent) {
            lastPercent = percent;
            publish({ phase: "downloading", nextVersion: manifest.version, percent });
          }
        }
      } catch (error) {
        await handle.close();
        await fs.rm(pending, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
      if (size !== manifest.size || hash.digest("hex") !== manifest.sha256) {
        await fs.rm(pending, { force: true });
        throw new Error("Update download failed integrity verification.");
      }
      await fs.rename(pending, file);
    }
    downloaded = { file, manifest };
    publish({ phase: "ready", nextVersion: manifest.version });
    return state;
  }
  return {
    get state() {
      return state;
    },
    check() {
      if (!running) {
        running = prepare()
          .catch((error) => {
            publish({ phase: "error", error: String(error.message ?? error) });
            return state;
          })
          .finally(() => {
            running = undefined;
          });
      }
      return running;
    },
    async prepareInstall() {
      if (state.phase !== "ready" || !downloaded) throw new Error("No verified update is ready.");
      await verifyInstaller(downloaded.file, downloaded.manifest);
      return downloaded.file;
    },
  };
}

/** Call only after the owned service has drained; the installer restarts the updated app. */
export function launchInstaller(file, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, ["/S", "--updated", "--force-run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
