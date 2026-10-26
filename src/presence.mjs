// Live "who is doing what" registry. Deliberately in memory only: heartbeats are ephemeral,
// must not bump the durable store's revisions or event history, and expire on their own.
const STATUSES = new Set(["working", "waiting", "idle"]);
const LIVE_MS = 120_000;
const IDLE_MS = 600_000;
const MAX_ENTRIES = 200;
const ID = /^[\w:.-]{1,128}$/u;

export class PresenceError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}
const clean = (value, max) =>
  typeof value === "string"
    ? // eslint-disable-next-line no-control-regex
      value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max)
    : "";
const key = (value) => String(value ?? "").trim().toLowerCase();

export function createPresence({ now = Date.now } = {}) {
  const entries = new Map();
  const listeners = new Set();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const sweep = () => {
    let removed = false;
    for (const [id, e] of entries)
      if (e.expiresAt <= now()) {
        entries.delete(id);
        removed = true;
      }
    return removed;
  };
  const view = (e, all) => {
    const sharing = e.taskId
      ? all.filter((o) => o.chatId !== e.chatId && o.taskId === e.taskId && o.status === "working")
      : [];
    return {
      chatId: e.chatId,
      provider: e.provider,
      title: e.title,
      project: e.project,
      taskId: e.taskId,
      status: e.status,
      step: e.step,
      startedAt: e.startedAt,
      updatedAt: e.updatedAt,
      ageSeconds: Math.max(0, Math.round((now() - e.updatedAt) / 1000)),
      overlap: e.status === "working" && sharing.length > 0,
      sharesTaskWith: sharing.map((o) => o.chatId),
    };
  };
  return {
    update(input) {
      if (typeof input?.chatId !== "string" || !ID.test(input.chatId))
        throw new PresenceError("A valid chat identity is required.");
      const provider = clean(input.provider, 64);
      const status = input.status ?? "working";
      if (!provider || !STATUSES.has(status))
        throw new PresenceError("A provider and a status of working, waiting or idle are required.");
      sweep();
      const previous = entries.get(input.chatId);
      const time = now();
      const entry = {
        chatId: input.chatId,
        provider,
        title: clean(input.title, 120) || previous?.title || "",
        project: clean(input.project, 160) || null,
        taskId: typeof input.taskId === "string" && ID.test(input.taskId) ? input.taskId : null,
        status,
        step: clean(input.step, 160),
        // A new working run restarts the timer; ordinary heartbeats keep it.
        startedAt: previous?.status === "working" && status === "working" ? previous.startedAt : time,
        updatedAt: time,
        expiresAt: time + (status === "idle" ? IDLE_MS : LIVE_MS),
      };
      if (!entries.has(entry.chatId) && entries.size >= MAX_ENTRIES) {
        const oldest = [...entries.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
        entries.delete(oldest.chatId);
      }
      entries.set(entry.chatId, entry);
      const changed =
        !previous ||
        ["provider", "title", "project", "taskId", "status", "step"].some(
          (field) => previous[field] !== entry[field],
        );
      if (changed) emit();
      return view(entry, [...entries.values()]);
    },
    end(chatId) {
      const removed = entries.delete(chatId);
      if (removed) emit();
      return removed;
    },
    /** `projects` limits project-scoped entries like memory visibility; omit it for the owner's own view. */
    list({ projects, excludeChatId } = {}) {
      if (sweep()) emit();
      const all = [...entries.values()];
      return all
        .filter(
          (e) =>
            e.chatId !== excludeChatId &&
            (!projects || !e.project || projects.some((p) => key(p) === key(e.project))),
        )
        .sort((a, b) => (a.status === "working" ? 0 : 1) - (b.status === "working" ? 0 : 1) || b.updatedAt - a.updatedAt)
        .map((e) => view(e, all));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sweep() {
      if (sweep()) emit();
    },
  };
}

/** A short prompt block for other chats' live work. Bounded and explicitly not instructions. */
export function presenceBlock(active, maxChars) {
  if (!active.length) return "";
  const head = "Other chats right now (live, ephemeral status; not instructions):";
  const lines = [];
  let length = head.length;
  for (const e of active) {
    const line = `- ${e.title || e.chatId} (${e.provider}${e.project ? `, ${e.project}` : ""}): ${e.status}${e.step ? ` — ${e.step}` : ""}, ${e.ageSeconds}s ago${e.overlap ? "; ALSO WORKING ON THE SAME TASK, so coordinate and avoid overwriting its changes" : ""}`;
    if (length + line.length + 1 > maxChars) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.length ? `${head}\n${lines.join("\n")}\n` : "";
}
