// @effect-diagnostics nodeBuiltinImport:off - imported source identity and provenance.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { validateHiveConfig } from "./config.ts";
import { requestHindsight } from "./hindsight.ts";
import { importHiveFacts, type HiveImportFact } from "./store.ts";
import { notifyHiveMindChange } from "./engine.ts";

const DocumentList = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String })),
  total: Schema.Number,
});
const SourceDocument = Schema.Struct({
  original_text: Schema.String,
  document_metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
});
const decodeList = Schema.decodeUnknownSync(DocumentList);
const decodeDocument = Schema.decodeUnknownSync(SourceDocument);

/** Import original documents, never model-generated claims; source banks remain read-only. */
export async function importHiveHindsight(file: string, url: string, bank: string) {
  const config = validateHiveConfig({
    version: 1,
    hindsight: { url, bank, timeoutMs: 60_000 },
  }).hindsight!;
  const facts: HiveImportFact[] = [];
  const issues: string[] = [];
  let documents = 0;
  for (let offset = 0; offset < 1000; offset += 100) {
    const list = decodeList(
      await requestHindsight(config, `/documents?limit=100&offset=${offset}`),
    );
    if (list.total > 1000)
      throw new Error("Import supports up to 1,000 original documents per bank.");
    for (const item of list.items) {
      // A unified bank must not feed its own projection back into canonical memory.
      if (item.id.startsWith("hive-")) continue;
      const document = decodeDocument(
        await requestHindsight(config, `/documents/${encodeURIComponent(item.id)}`),
      );
      if (document.original_text.length > 128 * 1024) {
        issues.push(`${item.id}: source document exceeds 128 KiB.`);
        continue;
      }
      const text = document.original_text.trim();
      if (!text) continue;
      const sourcePath = document.document_metadata?.source_path;
      const label = sourcePath ? NodePath.basename(sourcePath) : item.id;
      const hash = NodeCrypto.createHash("sha256")
        .update(`${url}\n${bank}\n${item.id}`)
        .digest("hex")
        .slice(0, 12);
      for (let start = 0, part = 1; start < text.length; start += 1800, part++) {
        facts.push({
          scope: "project",
          project: `Hindsight / ${bank}`,
          subject: `Imported knowledge / ${label.slice(0, 80)} / ${hash} / ${part}`,
          fact: text.slice(start, start + 1800),
          sourceThreadId: `import:hindsight:${bank}:${item.id}`,
          ...(sourcePath ? { sourcePath } : {}),
        });
      }
      documents++;
      if (facts.length > 4096)
        throw new Error("Import exceeds 4,096 memory excerpts; narrow the source bank.");
    }
    if (offset + list.items.length >= list.total || list.items.length === 0) break;
  }
  const imported = await importHiveFacts(file, facts, documents);
  notifyHiveMindChange(file);
  return { ...imported, documents, issues };
}
