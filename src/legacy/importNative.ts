// @effect-diagnostics nodeBuiltinImport:off - reads provider-owned Markdown files without modifying them.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { HiveImportFact } from "./store.ts";

export interface NativeMemoryPreview {
  readonly facts: ReadonlyArray<HiveImportFact>;
  readonly sources: ReadonlyArray<{ readonly name: string; readonly entries: number }>;
  readonly redactedSensitiveValues: number;
}

const sensitiveValue = /(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AIza[\w-]{20,})/gu;
const privateKeyBlock =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu;
const redactSensitive = (text: string) => {
  let redactions = 0;
  const redacted = text
    .replace(privateKeyBlock, () => {
      redactions++;
      return "[redacted private key]";
    })
    .replace(sensitiveValue, () => {
      redactions++;
      return "[redacted credential]";
    });
  return { text: redacted, redactions };
};
const projectFromPath = (value: string, fallback: string): string => {
  const match = /[A-Za-z]:\\Projects\\([^\\;\n]+)/iu.exec(value);
  return match?.[1]?.trim() || fallback;
};

export function parseCodexMemory(markdown: string): {
  readonly facts: ReadonlyArray<HiveImportFact>;
  readonly redactedSensitiveValues: number;
} {
  const facts: HiveImportFact[] = [];
  let redactedSensitiveValues = 0;
  let group = "General";
  let project = "General";
  let section: "preferences" | "knowledge" | null = null;
  let ordinal = 0;
  let pending = "";
  const flush = () => {
    if (!pending || section === null) return;
    const redacted = redactSensitive(pending.trim());
    const fact = redacted.text;
    pending = "";
    redactedSensitiveValues += redacted.redactions;
    const label = section === "preferences" ? "Preference" : "Knowledge";
    const subject = `Codex / ${group.slice(0, 105)} / ${label} ${ordinal}`;
    facts.push({
      scope: section === "preferences" ? "general" : "project",
      project: section === "preferences" ? null : project,
      subject,
      fact,
      sourceThreadId: `import:codex:MEMORY.md:${group.slice(0, 60)}:${section}:${ordinal}`,
    });
  };
  for (const line of markdown.split(/\r?\n/u)) {
    const groupMatch = /^# Task Group: (.+)$/u.exec(line);
    if (groupMatch) {
      flush();
      group = groupMatch[1]?.trim() ?? "General";
      project = group;
      section = null;
      ordinal = 0;
      continue;
    }
    if (line.startsWith("applies_to:")) {
      project = projectFromPath(line, group);
    }
    if (line === "## User preferences" || line === "## Reusable knowledge") {
      flush();
      section = line === "## User preferences" ? "preferences" : "knowledge";
      ordinal = 0;
      continue;
    }
    if (line.startsWith("#") || line.length === 0) {
      flush();
      if (line.startsWith("## ")) section = null;
      continue;
    }
    if (section === null) continue;
    if (line.startsWith("- ")) {
      flush();
      ordinal++;
      pending = line.slice(2);
    } else if (pending && /^\s+\S/u.test(line)) {
      pending += ` ${line.trim()}`;
    }
  }
  flush();
  return { facts, redactedSensitiveValues };
}

export function parseClaudeMemory(
  markdown: string,
  project: string,
  filename: string,
): HiveImportFact | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(markdown);
  const body = (frontmatter ? markdown.slice(frontmatter[0].length) : markdown).trim();
  if (!body || body.length > 2_000) return null;
  const name = /^name:\s*(.+)$/mu.exec(frontmatter?.[1] ?? "")?.[1]?.trim() ?? filename;
  return {
    scope: "project",
    project,
    subject: `Claude / ${project.slice(0, 75)} / ${name.slice(0, 65)}`,
    fact: body,
    sourceThreadId: `import:claude:${project}/${filename}`,
  };
}

/** Split archived notes without dropping paragraphs or truncating long lines. */
export function archiveMarkdown(
  markdown: string,
  input: { readonly source: string; readonly subject: string; readonly project: string },
): { readonly facts: ReadonlyArray<HiveImportFact>; readonly redactedSensitiveValues: number } {
  const facts: HiveImportFact[] = [];
  const redacted = redactSensitive(markdown);
  const redactedSensitiveValues = redacted.redactions;
  let remaining = redacted.text.trim();
  let part = 0;
  while (remaining) {
    let cut = remaining.length;
    if (cut > 1_800) {
      const paragraph = remaining.lastIndexOf("\n\n", 1_800);
      const line = remaining.lastIndexOf("\n", 1_800);
      cut = paragraph > 900 ? paragraph : line > 900 ? line : 1_800;
    }
    const fact = remaining.slice(0, cut).trim();
    remaining = remaining.slice(cut).trimStart();
    part++;
    if (!fact) continue;
    facts.push({
      scope: "project",
      project: input.project,
      subject: `${input.subject.slice(0, 140)} / Part ${part}`,
      fact,
      sourceThreadId: `import:codex:${input.source}:${part}`,
    });
  }
  return { facts, redactedSensitiveValues };
}

/** Claude.ai account memory is exported explicitly by the account owner. */
export function parseClaudeAccountMemory(markdown: string): {
  readonly facts: ReadonlyArray<HiveImportFact>;
  readonly redactedSensitiveValues: number;
} {
  const headings = [...markdown.matchAll(/^## (.+)$/gmu)];
  const sections =
    headings.length === 0
      ? [{ title: "Account", body: markdown }]
      : headings.map((heading, index) => ({
          title: heading[1]?.trim() || `Section ${index + 1}`,
          body: markdown.slice(
            (heading.index ?? 0) + heading[0].length,
            headings[index + 1]?.index ?? markdown.length,
          ),
        }));
  const parsed = sections.map((section, index) =>
    archiveMarkdown(section.body, {
      source: `claude-account/section-${index + 1}`,
      subject: `Claude.ai account memory / ${section.title}`,
      project: "Claude.ai",
    }),
  );
  return {
    facts: parsed.flatMap((section) =>
      section.facts.map((fact) => ({
        ...fact,
        scope: "general" as const,
        project: null,
        sourceThreadId: fact.sourceThreadId.replace("import:codex:", "import:claude-account:"),
      })),
    ),
    redactedSensitiveValues: parsed.reduce(
      (sum, section) => sum + section.redactedSensitiveValues,
      0,
    ),
  };
}

async function readRegularFile(file: string, maxBytes: number): Promise<string | null> {
  try {
    const stat = await NodeFSP.lstat(file);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) throw new Error(`Native memory file exceeds import limit: ${file}`);
    return await NodeFSP.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function previewNativeMemoryImport(home: string): Promise<NativeMemoryPreview> {
  const facts: HiveImportFact[] = [];
  const sources: Array<{ name: string; entries: number }> = [];
  let redactedSensitiveValues = 0;
  const codexFile = NodePath.join(home, ".codex", "memories", "MEMORY.md");
  const codex = await readRegularFile(codexFile, 512_000);
  if (codex !== null) {
    const parsed = parseCodexMemory(codex);
    facts.push(...parsed.facts);
    redactedSensitiveValues += parsed.redactedSensitiveValues;
    sources.push({ name: ".codex/memories/MEMORY.md", entries: parsed.facts.length });
  }

  const archives: ReadonlyArray<{ name: string; project: string; label: string }> = [
    { name: "memory_summary.md", project: "Codex summary", label: "Codex summary" },
    { name: "raw_memories.md", project: "Codex raw memory", label: "Codex raw memory" },
  ];
  for (const archive of archives) {
    const markdown = await readRegularFile(
      NodePath.join(home, ".codex", "memories", archive.name),
      512_000,
    );
    if (markdown === null) continue;
    const parsed = archiveMarkdown(markdown, {
      source: archive.name,
      subject: archive.label,
      project: archive.project,
    });
    facts.push(...parsed.facts);
    redactedSensitiveValues += parsed.redactedSensitiveValues;
    sources.push({ name: `.codex/memories/${archive.name}`, entries: parsed.facts.length });
  }

  const rolloutRoot = NodePath.join(home, ".codex", "memories", "rollout_summaries");
  const rollouts = await NodeFSP.readdir(rolloutRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  for (const file of rollouts) {
    if (!file.isFile() || !file.name.endsWith(".md")) continue;
    const markdown = await readRegularFile(NodePath.join(rolloutRoot, file.name), 64_000);
    if (markdown === null) continue;
    const parsed = archiveMarkdown(markdown, {
      source: `rollout_summaries/${file.name}`,
      subject: `Codex rollout / ${file.name.slice(0, 105)}`,
      project: projectFromPath(markdown, file.name.replace(/\.md$/u, "")),
    });
    facts.push(...parsed.facts);
    redactedSensitiveValues += parsed.redactedSensitiveValues;
    sources.push({
      name: `.codex/memories/rollout_summaries/${file.name}`,
      entries: parsed.facts.length,
    });
  }

  const skillsRoot = NodePath.join(home, ".codex", "memories", "skills");
  const skillDirectories = await NodeFSP.readdir(skillsRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  for (const directory of skillDirectories) {
    if (!directory.isDirectory()) continue;
    const markdown = await readRegularFile(
      NodePath.join(skillsRoot, directory.name, "SKILL.md"),
      64_000,
    );
    if (markdown === null) continue;
    const parsed = archiveMarkdown(markdown, {
      source: `skills/${directory.name}/SKILL.md`,
      subject: `Codex memory skill / ${directory.name}`,
      project: directory.name,
    });
    facts.push(...parsed.facts);
    redactedSensitiveValues += parsed.redactedSensitiveValues;
    sources.push({
      name: `.codex/memories/skills/${directory.name}/SKILL.md`,
      entries: parsed.facts.length,
    });
  }

  const projectsRoot = NodePath.join(home, ".claude", "projects");
  const projects = await NodeFSP.readdir(projectsRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  for (const directory of projects) {
    if (!directory.isDirectory()) continue;
    const memoryDirectory = NodePath.join(projectsRoot, directory.name, "memory");
    const files = await NodeFSP.readdir(memoryDirectory, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    const project = directory.name.startsWith("C--Projects-")
      ? directory.name.slice("C--Projects-".length).replaceAll("-", " ")
      : directory.name;
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      const markdown = await readRegularFile(NodePath.join(memoryDirectory, file.name), 64_000);
      if (markdown === null) continue;
      if (file.name === "MEMORY.md") {
        const parsed = archiveMarkdown(markdown, {
          source: `claude-index/${directory.name}/MEMORY.md`,
          subject: `Claude index / ${project}`,
          project,
        });
        facts.push(
          ...parsed.facts.map((fact) => ({
            ...fact,
            sourceThreadId: fact.sourceThreadId.replace("import:codex:", "import:claude:"),
          })),
        );
        redactedSensitiveValues += parsed.redactedSensitiveValues;
        sources.push({
          name: `.claude/projects/${directory.name}/memory/MEMORY.md`,
          entries: parsed.facts.length,
        });
        continue;
      }
      const redacted = redactSensitive(markdown);
      redactedSensitiveValues += redacted.redactions;
      const parsed = parseClaudeMemory(redacted.text, project, file.name);
      if (parsed === null) {
        continue;
      }
      facts.push(parsed);
      sources.push({ name: `.claude/projects/${directory.name}/memory/${file.name}`, entries: 1 });
    }
  }
  return { facts, sources, redactedSensitiveValues };
}
