import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { HiveMindConfig } from "./config.ts";
import { hiveMemoryDigest, type HiveMemory } from "./store.ts";

type Config = NonNullable<HiveMindConfig["hindsight"]>;
const RecallResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      document_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
      metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    }),
  ),
});
const RetainResponse = Schema.Struct({ success: Schema.Boolean, async: Schema.Boolean });
const decodeRecall = Schema.decodeUnknownSync(RecallResponse);
const decodeRetain = Schema.decodeUnknownSync(RetainResponse);
class HiveRetrievalError extends Schema.TaggedError<HiveRetrievalError>()("HiveRetrievalError", {
  message: Schema.String,
}) {}
export const hiveDocumentId = (memory: HiveMemory) => `hive-${memory.id}`;

/** Retrieval is a derived index. Extracted text never replaces the authoritative fact. */
export async function recallHindsight(config: Config, query: string) {
  const response = await request(config, "/memories/recall", {
    query,
    budget: "low",
    max_tokens: 2048,
    types: ["world", "experience"],
    tags: ["j1-hive-mind"],
    tags_match: "all_strict",
  });
  return decodeRecall(response).results;
}

export async function retainHindsight(config: Config, memories: ReadonlyArray<HiveMemory>) {
  const response = await request(config, "/memories", {
    async: false,
    items: memories.map((memory) => ({
      content: `${memory.subject}\n${memory.fact}`,
      document_id: hiveDocumentId(memory),
      update_mode: "replace",
      timestamp: memory.updatedAt,
      metadata: { hive_id: memory.id, hive_digest: hiveMemoryDigest(memory) },
      tags: ["j1-hive-mind", memory.scope, ...(memory.project ? [memory.project] : [])],
    })),
  });
  const receipt = decodeRetain(response);
  if (!receipt.success || receipt.async)
    throw new Error("Hive Mind index did not confirm a completed retain operation.");
}

export async function forgetHindsight(config: Config, id: string) {
  await request(config, `/documents/${encodeURIComponent(`hive-${id}`)}`, undefined, "DELETE");
}

export function requestHindsight(config: Config, route: string) {
  return request(config, route, undefined, "GET");
}
function request(
  config: Config,
  route: string,
  body: unknown,
  method: "POST" | "DELETE" | "GET" = "POST",
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const base = HttpClientRequest.make(method)(
        `${config.url.replace(/\/$/u, "")}/v1/default/banks/${encodeURIComponent(config.bank)}${route}`,
      );
      const request = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body);
      const response = yield* client.execute(request);
      if (
        (response.status < 200 || response.status >= 300) &&
        !(method === "DELETE" && response.status === 404)
      )
        return yield* new HiveRetrievalError({
          message: `Hive Mind retrieval returned HTTP ${response.status}.`,
        });
      return method === "DELETE" ? undefined : yield* response.json;
    }).pipe(
      Effect.timeout(config.timeoutMs ?? 5_000),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    ),
  );
}
