// @effect-diagnostics nodeBuiltinImport:off - atomic projection files at the Node filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function readOptional(file: string) {
  try {
    const stat = await NodeFSP.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000)
      throw new Error("Hive Mind projection must be a regular file under 4 MB.");
    return await NodeFSP.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function ensureDirectory(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true });
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Hive Mind projection directories must not be symbolic links.");
}

/** Windows can briefly refuse to replace a file another operation has open; retry instead of failing the write. */
export async function renameReplacing(from: string, to: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await NodeFSP.rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt));
    }
  }
}

export async function writeAtomic(file: string, text: string) {
  await ensureDirectory(NodePath.dirname(file));
  await readOptional(file);
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await renameReplacing(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
