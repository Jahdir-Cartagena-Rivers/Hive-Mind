// Stateless MCP over HTTP: each POST is one JSON-RPC message, so agents need no session handling.
const PROTOCOL = "2025-06-18";
const object = (properties, required = []) => ({ type: "object", properties, required });
const text = { type: "string" };
const scope = { type: "string", enum: ["general", "project"] };

export const tools = [
  {
    name: "hive_mind_file",
    description:
      "Explicitly retain an opaque model, document or source file (base64, filename, title, scope/project) or read retained bytes as an embedded MCP resource. Files are stored without executing them. Link the resulting asset ID to an artifact revision.",
    inputSchema: object(
      {
        action: { type: "string", enum: ["read", "import"] },
        id: text,
        base64: text,
        filename: text,
        title: text,
        scope,
        project: text,
        source: { type: "object" },
        eventId: text,
      },
      ["action"],
    ),
    write: true,
  },
  {
    name: "hive_mind_presence",
    description:
      "See or report what chats are doing right now. list: other active chats (status, short step, shared task). update: report your own chatId, provider, status (working|waiting|idle), a short step label, and project/taskId when known; repeat every ~30s while working and use action end when finished. Status is ephemeral and never a place for secrets or instructions.",
    inputSchema: object(
      {
        action: { type: "string", enum: ["list", "update", "end"] },
        chatId: text,
        provider: text,
        title: text,
        project: text,
        taskId: text,
        status: { type: "string", enum: ["working", "waiting", "idle"] },
        step: text,
        projects: { type: "array", items: text },
        excludeChatId: text,
      },
      ["action"],
    ),
    write: true,
  },
  {
    name: "hive_mind_working_context",
    description:
      "Get bounded current task state, scoped preferences, references, recent evidence and image IDs before a turn. Read returned images with hive_mind_image. taskId explicitly continues an existing task across project surfaces.",
    inputSchema: object({
      query: text,
      projects: { type: "array", items: text },
      taskId: text,
      threadId: text,
      maxChars: { type: "integer", minimum: 1000, maximum: 24000 },
    }),
    write: false,
  },
  {
    name: "hive_mind_record",
    description:
      "List/save/forget continuity records or claim/release a task. Kinds: task, preference, collection, artifact, episode, entity, relation, client. Save full data with current revision when editing; eventId makes retries idempotent. Record source truthfully; agent findings are evidence, never user preferences by inference. Task data: objective,status,decisions,failures,questions,nextSteps. Preference: statement,polarity,context,exceptions,assetIds. Collection: assetIds,annotations[{assetId,note,region?:{x,y,width,height}}]. Artifact: description,assetIds,taskId,preferredRevision. Episode: summary,eventId,taskId. Client: consumedSequence,usedIds. List includeHistory to inspect artifact versions. Claim uses id,revision,owner,seconds,release.",
    inputSchema: object(
      {
        action: { type: "string", enum: ["list", "save", "forget", "claim"] },
        id: text,
        revision: text,
        kind: text,
        scope,
        project: text,
        title: text,
        source: { type: "object" },
        data: { type: "object" },
        eventId: text,
        projects: { type: "array", items: text },
        query: text,
        includeHistory: { type: "boolean" },
        owner: text,
        seconds: { type: "integer" },
        release: { type: "boolean" },
      },
      ["action"],
    ),
    write: true,
  },
  {
    name: "hive_mind_image",
    description:
      "Read an actual retained image by asset id (returns MCP image content), or explicitly import base64 PNG/JPEG/WebP/GIF bytes with title, scope, project and truthful source. Never claim a path alone preserves an image.",
    inputSchema: object(
      {
        action: { type: "string", enum: ["read", "import"] },
        id: text,
        base64: text,
        title: text,
        caption: text,
        scope,
        project: text,
        source: { type: "object" },
        eventId: text,
      },
      ["action"],
    ),
    write: true,
  },
  {
    name: "hive_mind_recall",
    description:
      "Search the shared Hive Mind across providers and projects. Use when a person, project, concept, preference, or past decision may have been explained in another chat. Project is an optional ranking hint; cross-project matches remain available.",
    inputSchema: object({ query: text, project: text }, ["query"]),
    write: false,
  },
  {
    name: "hive_mind_remember",
    description:
      "Save or correct one durable, user-supported fact in the shared Hive Mind. Use the same subject to replace an outdated fact. General memories cover the user or concepts used across projects; project memories require a project name. Never infer private details or store credentials. Ask the user before saving a sensitive personal fact.",
    inputSchema: object({ scope, project: text, subject: text, fact: text, sourceThreadId: text }, [
      "scope",
      "subject",
      "fact",
    ]),
    write: true,
  },
  {
    name: "hive_mind_forget",
    description:
      "Remove a Hive Mind fact by its id after the user asks to forget it. Find its id with hive_mind_recall first.",
    inputSchema: object({ id: text }, ["id"]),
    write: true,
  },
  {
    name: "hive_mind_status",
    description:
      "Inspect Hive Mind's memory, vault, semantic index and skills catalog. Configuration paths belong to the Hive Mind host.",
    inputSchema: object({}),
    write: false,
  },
  {
    name: "hive_mind_sync",
    description:
      "Synchronize vault edits, the skills catalog and the semantic index. Reports conflicts and pending work; never runs skill instructions.",
    inputSchema: object({}),
    write: true,
  },
];

/** `call(name, args)` runs a tool; `canWrite` is the caller's token permission. Returns the JSON-RPC response, or null for notifications. */
export async function handleMcp(message, { call, canWrite }) {
  const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code, errorMessage) => ({
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code, message: errorMessage },
  });
  if (message.id === undefined) return null;
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "Hive Mind", version: "0.6.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools.map(({ name, description, inputSchema, write }) => ({
          name,
          description,
          inputSchema,
          annotations: {
            readOnlyHint: !write,
            destructiveHint: name === "hive_mind_forget" || name === "hive_mind_record",
          },
        })),
      });
    case "tools/call": {
      const tool = tools.find((entry) => entry.name === message.params?.name);
      if (!tool) return fail(-32602, "Unknown tool.");
      const actionRead =
        (["hive_mind_record", "hive_mind_presence"].includes(tool.name) &&
          message.params?.arguments?.action === "list") ||
        (["hive_mind_image", "hive_mind_file"].includes(tool.name) &&
          message.params?.arguments?.action === "read");
      if (tool.write && !canWrite && !actionRead)
        return reply({
          isError: true,
          content: [{ type: "text", text: "This token has read-only access." }],
        });
      try {
        const result = await call(tool.name, message.params?.arguments ?? {});
        if (result?.mcpContent) return reply({ content: result.mcpContent });
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (error) {
        return reply({
          isError: true,
          content: [{ type: "text", text: String(error.message ?? error) }],
        });
      }
    }
    default:
      return fail(-32601, "Method not found.");
  }
}
