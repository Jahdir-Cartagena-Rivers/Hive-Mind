// @effect-diagnostics nodeBuiltinImport:off - fixtures exercise discovery in isolated native-memory trees.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";
import {
  archiveMarkdown,
  parseClaudeAccountMemory,
  parseCodexMemory,
  previewNativeMemoryImport,
} from "./importNative.ts";

describe("native memory import", () => {
  it("imports every local memory layer with provider and project provenance", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-native-memory-"));
    try {
      const codexDir = NodePath.join(home, ".codex", "memories");
      const rolloutDir = NodePath.join(codexDir, "rollout_summaries");
      const skillDir = NodePath.join(codexDir, "skills", "example");
      const claudeDir = NodePath.join(
        home,
        ".claude",
        "projects",
        "C--Projects-Sample-Workspace",
        "memory",
      );
      await NodeFSP.mkdir(codexDir, { recursive: true });
      await NodeFSP.mkdir(rolloutDir, { recursive: true });
      await NodeFSP.mkdir(skillDir, { recursive: true });
      await NodeFSP.mkdir(claudeDir, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(codexDir, "MEMORY.md"),
        [
          "# Task Group: Nebula media work",
          "applies_to: cwd=C:\\Projects\\SampleApp; reuse_rule=verify current state",
          "## User preferences",
          "- The user prefers brief handoffs. [Task 1]",
          "## Reusable knowledge",
          "- Nebula is the user's SampleApp concept. [Task 1]",
          "## Failures and how to do differently",
          "- This section is not imported.",
        ].join("\n"),
      );
      await NodeFSP.writeFile(
        NodePath.join(codexDir, "memory_summary.md"),
        "Nebula summary context.",
      );
      await NodeFSP.writeFile(
        NodePath.join(codexDir, "raw_memories.md"),
        "Nebula raw thread context.",
      );
      await NodeFSP.writeFile(
        NodePath.join(rolloutDir, "example.md"),
        "cwd: C:\\Projects\\SampleApp\nNebula rollout detail.",
      );
      await NodeFSP.writeFile(
        NodePath.join(skillDir, "SKILL.md"),
        "Nebula memory skill reference.",
      );
      await NodeFSP.writeFile(
        NodePath.join(claudeDir, "runner.md"),
        [
          "---",
          "name: runner-isolation",
          "description: Keep the runner isolated",
          "---",
          "Do not point the runner at production data.",
        ].join("\n"),
      );
      await NodeFSP.writeFile(NodePath.join(claudeDir, "MEMORY.md"), "index only");
      const preview = await previewNativeMemoryImport(home);
      NodeAssert.equal(preview.facts.length, 8);
      NodeAssert.equal(preview.sources.length, 7);
      NodeAssert.equal(preview.facts[0]?.scope, "general");
      NodeAssert.equal(preview.facts[1]?.project, "SampleApp");
      NodeAssert.equal(preview.facts.at(-2)?.project, "Sample Workspace");
      NodeAssert.match(preview.facts.at(-2)?.sourceThreadId ?? "", /^import:claude:/u);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });

  it("redacts a credential-like value while preserving the rest of the note", () => {
    const parsed = parseCodexMemory(
      [
        "# Task Group: Credentials",
        "## User preferences",
        `- key sk-${"x".repeat(25)}`,
        "- Prefers short answers.",
      ].join("\n"),
    );
    NodeAssert.equal(parsed.redactedSensitiveValues, 1);
    NodeAssert.equal(parsed.facts.length, 2);
    NodeAssert.match(parsed.facts[0]?.fact ?? "", /\[redacted credential\]/u);
  });

  it("redacts a value that spans archive chunk boundaries", () => {
    const token = `sk-${"x".repeat(25)}`;
    const archive = archiveMarkdown(`${"a".repeat(1_790)}${token} end`, {
      source: "raw_memories.md",
      subject: "Archive",
      project: "Example",
    });
    NodeAssert.equal(archive.redactedSensitiveValues, 1);
    NodeAssert.equal(
      archive.facts.some((fact) => fact.fact.includes(token)),
      false,
    );
  });

  it("imports an explicit Claude.ai account export as cross-project memory", () => {
    const account = parseClaudeAccountMemory(
      "## Profile\nThe user prefers concise answers.\n## Nebula\nNebula is a recurring project.",
    );
    NodeAssert.equal(account.facts.length, 2);
    NodeAssert.equal(account.facts[0]?.scope, "general");
    NodeAssert.equal(account.facts[0]?.project, null);
    NodeAssert.match(account.facts[0]?.sourceThreadId ?? "", /^import:claude-account:/u);
    NodeAssert.match(account.facts[1]?.subject ?? "", /Nebula/u);
  });
});
