// @effect-diagnostics nodeBuiltinImport:off - durable store metadata at the Node boundary.
import { createHash, randomUUID } from "node:crypto";
import type { HiveMemory } from "./store.ts";

export const brainKinds = [
  "task",
  "preference",
  "collection",
  "artifact",
  "episode",
  "entity",
  "relation",
  "asset",
  "client",
] as const;
export type BrainKind = (typeof brainKinds)[number];
export interface BrainRecord {
  id: string;
  kind: BrainKind;
  scope: "general" | "project";
  project: string | null;
  title: string;
  source: { threadId: string; provider: string; type: "user" | "agent" | "import" };
  data: Record<string, unknown>;
  revision: string;
  createdAt: string;
  updatedAt: string;
  history: Array<{
    revision: string;
    at: string;
    data: Record<string, unknown>;
    source?: BrainRecord["source"];
    title?: string;
    redacted?: boolean;
  }>;
}
export interface HiveChange {
  sequence: number;
  kind: string;
  id: string;
  revision: string | null;
  at: string;
}
export interface HiveContinuity {
  version: 1;
  streamId: string;
  sequence: number;
  events: HiveChange[];
  records: BrainRecord[];
  forgotten: string[];
  receipts: Array<{ key: string; digest: string; id: string }>;
}
export const newContinuity = (): HiveContinuity => ({
  version: 1,
  streamId: randomUUID(),
  sequence: 0,
  events: [],
  records: [],
  forgotten: [],
  receipts: [],
});
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
export const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const continuityMemories = (records: readonly BrainRecord[]): HiveMemory[] =>
  records
    .filter((r) => r.kind !== "client" && r.kind !== "relation")
    .map((r) => ({
      id: r.id,
      scope: r.scope,
      project: r.project,
      subject: r.title,
      fact: JSON.stringify({ kind: r.kind, sourceType: r.source.type, data: r.data }),
      sourceThreadId: r.source.threadId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (v: unknown, max = 4000) => typeof v === "string" && v.length <= max;
const strings = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every((s) => string(s));
const validRegion = (r: unknown) =>
  isObject(r) &&
  ["x", "y", "width", "height"].every(
    (k) =>
      typeof r[k] === "number" && Number.isFinite(r[k]) && Number(r[k]) >= 0 && Number(r[k]) <= 1,
  ) &&
  Number(r.x) + Number(r.width) <= 1 &&
  Number(r.y) + Number(r.height) <= 1;

export function validBrainRecord(value: unknown): value is BrainRecord {
  if (
    !isObject(value) ||
    !brainKinds.includes(value.kind as BrainKind) ||
    !string(value.id, 128) ||
    !value.id ||
    !string(value.title, 200) ||
    !value.title ||
    !["general", "project"].includes(String(value.scope)) ||
    !(value.scope === "general"
      ? value.project === null
      : string(value.project, 160) && !!value.project) ||
    !isObject(value.source) ||
    !string(value.source.threadId, 160) ||
    !string(value.source.provider, 80) ||
    !["user", "agent", "import"].includes(String(value.source.type)) ||
    !isObject(value.data) ||
    !string(value.revision, 64) ||
    !string(value.createdAt, 40) ||
    !string(value.updatedAt, 40) ||
    !Array.isArray(value.history) ||
    value.history.length > 100 ||
    !value.history.every(
      (h) =>
        isObject(h) &&
        string(h.revision, 64) &&
        string(h.at, 40) &&
        isObject(h.data) &&
        (h.title === undefined || string(h.title, 200)) &&
        (h.redacted === undefined || typeof h.redacted === "boolean") &&
        (h.source === undefined ||
          (isObject(h.source) &&
            string(h.source.threadId, 160) &&
            string(h.source.provider, 80) &&
            ["user", "agent", "import"].includes(String(h.source.type)))),
    )
  )
    return false;
  const d = value.data;
  for (const field of [
    "assetIds",
    "referenceIds",
    "deliveredIds",
    "decisions",
    "failures",
    "questions",
    "nextSteps",
    "exceptions",
    "tags",
  ]) {
    if (d[field] !== undefined && !strings(d[field])) return false;
  }
  if (JSON.stringify(d).length > 16000) return false;
  if (
    d.contextSequence !== undefined &&
    (!Number.isSafeInteger(d.contextSequence) || Number(d.contextSequence) < 0)
  )
    return false;
  if (d.contextStreamId !== undefined && !string(d.contextStreamId, 64)) return false;
  switch (value.kind) {
    case "task":
      return (
        string(d.objective) &&
        ["open", "active", "blocked", "paused", "done"].includes(String(d.status)) &&
        (d.lease === undefined ||
          d.lease === null ||
          (isObject(d.lease) &&
            string(d.lease.owner, 160) &&
            typeof d.lease.expiresAt === "number" &&
            Number.isFinite(d.lease.expiresAt)))
      );
    case "preference":
      return (
        string(d.statement) &&
        ["like", "dislike", "constraint"].includes(String(d.polarity)) &&
        string(d.context) &&
        (d.taskId === undefined || string(d.taskId, 128))
      );
    case "collection":
      return (
        strings(d.assetIds) &&
        (d.annotations === undefined ||
          (Array.isArray(d.annotations) &&
            d.annotations.length <= 100 &&
            d.annotations.every(
              (a) =>
                isObject(a) &&
                string(a.assetId, 128) &&
                string(a.note) &&
                (a.region === undefined || validRegion(a.region)),
            )))
      );
    case "artifact":
      return (
        string(d.description) &&
        strings(d.assetIds) &&
        (d.taskId === undefined || string(d.taskId, 128)) &&
        (d.preferredRevision === undefined || string(d.preferredRevision, 64))
      );
    case "episode":
      return (
        string(d.summary) &&
        string(d.eventId, 160) &&
        (d.taskId === undefined || string(d.taskId, 128))
      );
    case "entity":
      return string(d.description) && string(d.entityType, 80);
    case "relation":
      return string(d.from, 128) && string(d.to, 128) && string(d.relationship, 160);
    case "asset":
      return (
        /^[a-f0-9]{64}$/u.test(String(d.hash)) &&
        (d.media === "file"
          ? d.mime === "application/octet-stream" && string(d.filename, 255) && !!d.filename
          : ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(d.mime))) &&
        typeof d.bytes === "number" &&
        d.bytes > 0 &&
        d.bytes <= (d.media === "file" ? 25 : 10) * 1024 * 1024 &&
        typeof d.width === "number" &&
        typeof d.height === "number" &&
        (d.descriptor === undefined ||
          (isObject(d.descriptor) &&
            d.descriptor.algorithm === "hive-perceptual-v1" &&
            Array.isArray(d.descriptor.values) &&
            d.descriptor.values.length === 256 &&
            d.descriptor.values.every(
              (v) => typeof v === "number" && Number.isFinite(v) && v >= -1 && v <= 1,
            )))
      );
    case "client":
      return (
        Number.isSafeInteger(d.consumedSequence) &&
        Number(d.consumedSequence) >= 0 &&
        strings(d.usedIds) &&
        (d.taskId === undefined || string(d.taskId, 128))
      );
  }
  return false;
}

export function validContinuity(value: unknown): value is HiveContinuity {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !string(value.streamId, 64) ||
    !value.streamId ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    !Array.isArray(value.records) ||
    value.records.length > 10000 ||
    !value.records.every(validBrainRecord) ||
    new Set(value.records.map((r) => r.id)).size !== value.records.length ||
    !Array.isArray(value.forgotten) ||
    !value.forgotten.every((id) => string(id, 128)) ||
    !Array.isArray(value.receipts) ||
    !value.receipts.every(
      (r) => isObject(r) && string(r.key, 160) && string(r.digest, 64) && string(r.id, 128),
    ) ||
    !Array.isArray(value.events) ||
    value.events.length > 1000
  )
    return false;
  let previous = Number(value.sequence) - value.events.length;
  return value.events.every(
    (e) =>
      isObject(e) &&
      e.sequence === ++previous &&
      string(e.id, 128) &&
      string(e.kind, 100) &&
      (e.revision === null || string(e.revision, 64)) &&
      string(e.at, 40),
  );
}

/** Notification contains metadata only; forgotten content never survives in the replay log. */
export function commitChanges<
  T extends { memories: ReadonlyArray<{ id: string }>; continuity?: HiveContinuity },
>(before: T, after: T): T {
  const state = after.continuity ?? newContinuity();
  const changes: Array<{ kind: string; id: string; revision: string | null }> = [];
  for (const [kind, oldRecords, newRecords] of [
    ["memory", before.memories, after.memories],
    ["record", before.continuity?.records ?? [], state.records],
  ] as const) {
    const old = new Map(oldRecords.map((r) => [r.id, fingerprint(r)]));
    for (const record of newRecords) {
      const digest = fingerprint(record);
      if (old.get(record.id) !== digest)
        changes.push({ kind: `${kind}.saved`, id: record.id, revision: digest });
      old.delete(record.id);
    }
    for (const id of old.keys()) changes.push({ kind: `${kind}.forgotten`, id, revision: null });
  }
  let sequence = before.continuity?.sequence ?? 0;
  const at = new Date().toISOString();
  const events = [
    ...(before.continuity?.events ?? []),
    ...changes.map((e) => ({ ...e, at, sequence: ++sequence })),
  ].slice(-1000);
  return { ...after, continuity: { ...state, sequence, events } };
}
