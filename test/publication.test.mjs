import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectPublicFile, checkPublication } from "../scripts/check-publication.mjs";

test("publication rejects runtime data, bundles, unreviewed source, binary payloads and credential patterns", () => {
  for (const name of [
    "userdata/hive-mind.json",
    "apps/server/src/secret.ts",
    ".env",
    "dist/core.js",
    "installer.exe",
  ])
    assert.throws(() => inspectPublicFile(name, "data"));
  assert.throws(() => inspectPublicFile("README.md", Buffer.from([0, 1, 2])));
  assert.throws(() => inspectPublicFile("README.md", "x".repeat(140000)));
  assert.throws(() => inspectPublicFile("README.md", ["gh", "p_", "A".repeat(40)].join("")));
  assert.equal(inspectPublicFile("src/service.mjs", "export const example = true;"), true);
  assert.equal(inspectPublicFile("README.md", "# Product overview"), true);
});

test("synthetic fixtures reject personal memory and non-demo retrieval targets", () => {
  assert.throws(() =>
    inspectPublicFile(
      "examples/canonical-memory.example.json",
      JSON.stringify({
        version: 1,
        memories: [{ id: "real-record", sourceThreadId: "actual-chat", fact: "private" }],
      }),
    ),
  );
  assert.throws(() =>
    inspectPublicFile(
      "examples/hive-mind.config.example.json",
      JSON.stringify({
        vault: "/real/vault",
        hindsight: { url: "https://example.invalid", bank: "personal" },
      }),
    ),
  );
});

test("publication rejects a removed secret from reachable history", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hive-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git(["init", "--quiet"]);
  git(["config", "user.name", "Synthetic Test"]);
  git(["config", "user.email", "synthetic@example.invalid"]);
  fs.writeFileSync(path.join(directory, "README.md"), ["gh", "p_", "A".repeat(40)].join(""));
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "synthetic history fixture"]);
  fs.writeFileSync(path.join(directory, "README.md"), "# Safe current overview\n");
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "remove synthetic token"]);
  assert.throws(() => checkPublication(directory), /Possible credential/u);
});
