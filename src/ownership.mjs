import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** One process owns authoritative writes. A second service must never race JSON commits. */
export async function ownStateDirectory(directory) {
  const file = path.join(directory, "hive-mind.owner");
  const recovery = path.join(directory, "hive-mind.owner-recovery");
  const nonce = randomUUID();
  const create = async () => {
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    } finally {
      await handle.close();
    }
  };
  try {
    await create();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      await fs.mkdir(recovery);
    } catch {
      throw new Error(
        "Another Hive Mind service is acquiring this state directory. Retry after it finishes.",
      );
    }
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid state ownership file.");
      const owner = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        throw new Error("Invalid state ownership metadata.");
      try {
        process.kill(owner.pid, 0);
        throw new Error("This state directory already has a running Hive Mind owner.");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
      await fs.unlink(file);
      await create();
    } finally {
      await fs.rmdir(recovery);
    }
  }
  return async () => {
    const owner = JSON.parse(await fs.readFile(file, "utf8"));
    if (owner.nonce !== nonce || owner.pid !== process.pid)
      throw new Error("State ownership changed unexpectedly.");
    await fs.unlink(file);
  };
}
