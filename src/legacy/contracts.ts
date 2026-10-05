import * as Schema from "effect/Schema";

export const HiveMindConfig = Schema.Struct({
  version: Schema.Literal(1),
  vault: Schema.optionalKey(Schema.String),
  hindsight: Schema.optionalKey(
    Schema.Struct({
      url: Schema.String,
      bank: Schema.String,
      timeoutMs: Schema.optionalKey(Schema.Number),
    }),
  ),
  skills: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        project: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  automatic: Schema.optionalKey(Schema.Boolean),
  localEngine: Schema.optionalKey(
    Schema.Struct({ directory: Schema.String, ollama: Schema.optionalKey(Schema.String) }),
  ),
});
export type HiveMindConfig = typeof HiveMindConfig.Type;
export function updateHiveMindConfig<
  K extends "vault" | "hindsight" | "skills" | "automatic" | "localEngine",
>(config: HiveMindConfig, key: K, value: HiveMindConfig[K] | undefined): HiveMindConfig {
  const next = { ...config };
  if (value === undefined) delete next[key];
  else Object.assign(next, { [key]: value });
  return next;
}

export const HiveMindMemory = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literals(["general", "project"]),
  project: Schema.NullOr(Schema.String),
  subject: Schema.String,
  fact: Schema.String,
  sourceThreadId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(["memory", "skill"])),
  sourcePath: Schema.optionalKey(Schema.String),
  originSourceThreadId: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
});
export type HiveMindMemory = typeof HiveMindMemory.Type;
export const HiveMindRetrieval = Schema.Struct({
  status: Schema.Literals(["local", "ready", "degraded"]),
  message: Schema.optionalKey(Schema.String),
});
export const HiveMindSearchInput = Schema.Struct({
  query: Schema.String,
  project: Schema.optionalKey(Schema.String),
});
export const HiveMindSearchResult = Schema.Struct({
  memories: Schema.Array(HiveMindMemory),
  retrieval: HiveMindRetrieval,
});
export const HiveMindMutation = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("remember"),
    scope: Schema.Literals(["general", "project"]),
    project: Schema.optionalKey(Schema.String),
    subject: Schema.String,
    fact: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("edit"),
    id: Schema.String,
    revision: Schema.String,
    fact: Schema.String,
  }),
  Schema.Struct({ action: Schema.Literal("forget"), id: Schema.String }),
]);
export type HiveMindMutation = typeof HiveMindMutation.Type;
export const HiveMindSnapshot = Schema.Struct({
  config: HiveMindConfig,
  defaultVault: Schema.String,
  defaultBank: Schema.String,
  records: Schema.Number,
  skills: Schema.Number,
  pendingIndex: Schema.Number,
  phase: Schema.Literals(["idle", "syncing", "degraded", "paused"]),
  lastSync: Schema.NullOr(Schema.String),
  issues: Schema.Array(Schema.String),
});
export type HiveMindSnapshot = typeof HiveMindSnapshot.Type;
export const HiveMindImportInput = Schema.Struct({ url: Schema.String, bank: Schema.String });
export const HiveMindImportResult = Schema.Struct({
  created: Schema.Number,
  updated: Schema.Number,
  unchanged: Schema.Number,
  protected: Schema.Number,
  sources: Schema.Number,
  documents: Schema.Number,
  issues: Schema.Array(Schema.String),
});
export class HiveMindError extends Schema.TaggedError<HiveMindError>()("HiveMindError", {
  message: Schema.String,
}) {}
