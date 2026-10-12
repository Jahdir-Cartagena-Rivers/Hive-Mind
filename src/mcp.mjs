// Stateless MCP over HTTP: each POST is one JSON-RPC message, so agents need no session handling.
const PROTOCOL = "2025-06-18";
const object = (properties, required = []) => ({ type: "object", properties, required });
const text = { type: "string" };
const scope = { type: "string", enum: ["general", "project"] };

export const tools = [
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
    inputSchema: object({ scope, project: text, subject: text, fact: text }, [
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
        serverInfo: { name: "Hive Mind", version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools.map(({ name, description, inputSchema, write }) => ({
          name,
          description,
          inputSchema,
          annotations: { readOnlyHint: !write, destructiveHint: name === "hive_mind_forget" },
        })),
      });
    case "tools/call": {
      const tool = tools.find((entry) => entry.name === message.params?.name);
      if (!tool) return fail(-32602, "Unknown tool.");
      if (tool.write && !canWrite)
        return reply({
          isError: true,
          content: [{ type: "text", text: "This token has read-only access." }],
        });
      try {
        const result = await call(tool.name, message.params?.arguments ?? {});
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
