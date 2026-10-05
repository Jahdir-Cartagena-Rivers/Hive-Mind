import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_FILES = new Set([
  ".gitignore",
  ".gitattributes",
  "LICENSE",
  "README.md",
  "CONTRIBUTING.md",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  ".github/workflows/source-check.yml",
  "docs/architecture.md",
  "docs/licensing.md",
  "docs/service.md",
  "examples/README.md",
  "examples/canonical-memory.example.json",
  "examples/hive-mind.config.example.json",
  "examples/skills/thermal-review/SKILL.md",
  "examples/vault/Hive Mind/11111111-1111-4111-8111-111111111111.md",
  "licenses/LEGACY-MIT.txt",
  "licenses/T3-MIT.txt",
  "licenses/legacy-provenance.json",
  "src/service.mjs",
  "src/cli.mjs",
  "src/legacy/LICENSE",
  "test/service.test.mjs",
  "test/publication.test.mjs",
  "scripts/check-publication.mjs",
]);
const LEGACY_NAMES = new Set([
  "contracts.ts",
  "config.ts",
  "engine.ts",
  "engine.test.ts",
  "files.ts",
  "hindsight.ts",
  "importHindsight.ts",
  "importHindsight.test.ts",
  "importNative.ts",
  "importNative.test.ts",
  "importNative.cli.ts",
  "localEngine.ts",
  "localEngine.test.ts",
  "manage.cli.ts",
  "runtime.ts",
  "runtime.test.ts",
  "skills.ts",
  "store.ts",
  "store.test.ts",
  "vault.ts",
]);
const allowed = (name) =>
  ROOT_FILES.has(name) ||
  (name.startsWith("src/legacy/") && LEGACY_NAMES.has(name.slice("src/legacy/".length)));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

export function inspectPublicFile(name, contents) {
  if (!allowed(name)) throw new Error(`Unreviewed publication path: ${name}`);
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (buffer.includes(0)) throw new Error(`Binary payload: ${name}`);
  if (buffer.length > (name === "package-lock.json" ? 512 * 1024 : 128 * 1024))
    throw new Error(`Oversized payload: ${name}`);
  const text = buffer.toString("utf8");
  const secrets = [
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u,
    /\bsk-[A-Za-z0-9_-]{30,}\b/u,
    /\bAKIA[A-Z0-9]{16}\b/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ];
  if (secrets.some((pattern) => pattern.test(text)))
    throw new Error(`Possible credential in: ${name}`);
  if (name === "examples/canonical-memory.example.json") {
    const data = JSON.parse(text);
    if (
      data.version !== 1 ||
      data.memories?.length !== 1 ||
      data.memories[0].id !== "11111111-1111-4111-8111-111111111111" ||
      data.memories[0].sourceThreadId !== "synthetic-showcase" ||
      data.memories[0].project !== "Nebula" ||
      data.memories[0].fact !== "The synthetic Nebula prototype uses copper cooling fins."
    )
      throw new Error("Synthetic memory fixture contains unreviewed data.");
    const known = new Set([
      "id",
      "scope",
      "project",
      "subject",
      "fact",
      "sourceThreadId",
      "createdAt",
      "updatedAt",
    ]);
    if (
      Object.keys(data.memories[0]).some((key) => !known.has(key)) ||
      Object.keys(data).some((key) => !["version", "memories"].includes(key))
    )
      throw new Error("Unexpected synthetic memory fields.");
  }
  if (name === "examples/hive-mind.config.example.json") {
    const data = JSON.parse(text);
    if (
      data.vault !== "C:\\Knowledge\\Hive Mind Demo" ||
      data.hindsight?.url !== "http://127.0.0.1:8888" ||
      data.hindsight?.bank !== "hive-mind-demo" ||
      data.skills?.length !== 1 ||
      data.skills[0].path !== "C:\\Knowledge\\Demo Skills"
    )
      throw new Error("Configuration fixture is not the reviewed demonstration environment.");
  }
  return true;
}

export function checkPublication(root) {
  const files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  if (!files.length || files.length > 128) throw new Error("Unexpected tracked inventory.");
  for (const name of files) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Nonregular tracked file: ${name}`);
    inspectPublicFile(name, fs.readFileSync(file));
  }
  const commits = git(root, ["rev-list", "--all"]).trim().split(/\r?\n/u).filter(Boolean);
  let historyFiles = 0;
  for (const commit of commits) {
    const entries = git(root, ["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean);
    if (entries.length > 128) throw new Error("Unexpected historical inventory.");
    for (const entry of entries) {
      const match = entry.match(/^(\d+) blob ([a-f0-9]+)\t(.+)$/u);
      if (!match || !["100644", "100755"].includes(match[1]))
        throw new Error("Unexpected historical object type.");
      const name = match[3];
      if (!allowed(name)) throw new Error(`Unreviewed historical path: ${name}`);
      inspectPublicFile(name, git(root, ["cat-file", "blob", match[2]]));
      historyFiles++;
    }
  }
  const provenance = JSON.parse(
    fs.readFileSync(path.join(root, "licenses/legacy-provenance.json"), "utf8"),
  );
  if (
    provenance.sourceCommit !== "d709391df467a41c08c4b39767868b3808ce4666" ||
    provenance.license !== "MIT" ||
    provenance.files.length !== LEGACY_NAMES.size
  )
    throw new Error("Unexpected MIT provenance.");
  const seen = new Set();
  for (const record of provenance.files) {
    if (
      !record.file.startsWith("src/legacy/") ||
      !LEGACY_NAMES.has(path.basename(record.file)) ||
      seen.has(record.file)
    )
      throw new Error("Invalid provenance path.");
    seen.add(record.file);
    if (sha256(fs.readFileSync(path.join(root, record.file))) !== record.adaptedSha256)
      throw new Error(`MIT provenance fingerprint differs: ${record.file}`);
  }
  const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
  if (
    !license.includes("Previously granted permissions remain intact.") ||
    !license.includes("src/legacy/ is MIT")
  )
    throw new Error("Required prior-license exceptions are missing.");
  return {
    trackedFiles: files.length,
    commits: commits.length,
    historicalFiles: historyFiles,
    mitFiles: seen.size,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(JSON.stringify(checkPublication(root)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
