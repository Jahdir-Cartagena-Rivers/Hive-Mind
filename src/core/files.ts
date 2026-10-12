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

export async function writeAtomic(file: string, text: string) {
  await ensureDirectory(NodePath.dirname(file));
  await readOptional(file);
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
