import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import * as Schema from "effect/Schema";
import {
  HiveMindConfig,
  HiveMindMutation,
  HiveMindSearchInput,
  HiveMindImportInput,
} from "./core/contracts.ts";
import { HiveMindRuntime } from "./core/runtime.ts";
import { forgetHiveMind, hiveMindStatus, recallHiveMind, rememberHiveMind } from "./core/engine.ts";
import { hiveGraph, hiveMemoryDetail } from "./core/graph.ts";
import { handleMcp } from "./mcp.mjs";
import {
  readHiveMind,
  hiveContext,
  hiveMemoryDigest,
  editHiveFact,
  subscribeHiveChanges,
  mutateHiveStore,
} from "./core/store.ts";
import { newContinuity } from "./core/continuity.ts";
import {
  BrainError,
  brainSnapshot,
  saveBrainRecord,
  forgetBrainRecord,
  claimBrainTask,
  brainChanges,
  brainContext,
  importBrainAsset,
  importBrainFile,
  visualBrainSearch,
  readBrainAsset,
  exportBrain,
  restoreBrain,
} from "./brain.mjs";
import { importHiveHindsight } from "./core/importHindsight.ts";
import { HiveLocalEngine } from "./core/localEngine.ts";
import { readHiveConfig } from "./core/config.ts";
import { ownStateDirectory } from "./ownership.mjs";

const MAX_BODY = 64 * 1024;
const readOperations = new Set([
  "/v1/search",
  "/v1/graph",
  "/v1/memory",
  "/v1/context",
  "/v1/brain",
  "/v1/changes",
  "/v1/working-context",
  "/v1/archive/export",
  "/v1/visual-search",
]);
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const hash = (value) => createHash("sha256").update(value).digest();
const matches = (value, expected) => timingSafeEqual(hash(value), hash(expected));
const decode = (schema, input) => {
  try {
    return Schema.decodeUnknownSync(schema)(input);
  } catch {
    throw new RequestError(400, "Invalid request fields.");
  }
};

const decodeRemember = (body) => {
  if (
    body.sourceThreadId !== undefined &&
    (typeof body.sourceThreadId !== "string" || !/^[\w:.-]{1,128}$/u.test(body.sourceThreadId))
  )
    throw new RequestError(400, "Invalid source thread identity.");
  const input = decode(HiveMindMutation, { ...body, action: "remember" });
  if (input.scope === "project" && !input.project?.trim())
    throw new RequestError(
      400,
      "A project name is required for project memories. Retry with project set to the intended project name.",
    );
  return input;
};

export async function validateStateDirectory(directory) {
  if (!directory || !path.isAbsolute(directory))
    throw new Error("Provide an absolute dedicated state directory.");
  const resolved = path.resolve(directory);
  const forbidden = [".j1", ".t3"];
  if (resolved.split(/[\\/]/u).some((part) => forbidden.includes(part.toLowerCase())))
    throw new Error("Installed J1/T3 profiles cannot be used by the standalone service.");
  const home = path.resolve(os.homedir());
  if (resolved === home || resolved === path.parse(resolved).root)
    throw new Error("Choose a dedicated subdirectory.");
  let ancestor = resolved;
  while (true) {
    try {
      const stat = await fs.lstat(ancestor);
      if (stat.isSymbolicLink())
        throw new Error("State paths cannot contain symlinks or junctions.");
      if (!stat.isDirectory()) throw new Error("State path ancestors must be directories.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const name of ["state.sqlite", "state.sqlite-wal", "settings.json"]) {
    try {
      await fs.lstat(path.join(resolved, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      "The selected directory contains an application profile. Choose a separate directory.",
    );
  }
  for (const name of ["hive-mind.json", "hive-mind.config.json", "hive-mind.index.json"]) {
    try {
      const stat = await fs.lstat(path.join(resolved, name));
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("State files must be regular files, not symlinks.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return resolved;
}

async function readBody(request, limit = MAX_BODY) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new RequestError(415, "Use application/json.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new Error("Expected object.");
    return body;
  } catch {
    throw new RequestError(400, "Malformed JSON.");
  }
}

export async function startHiveMind({ stateDirectory, token, readToken, port = 8788 }) {
  if (typeof token !== "string" || token.length < 32 || /\s/u.test(token))
    throw new Error("HIVE_MIND_TOKEN must contain at least 32 non-whitespace characters.");
  if (
    readToken !== undefined &&
    (typeof readToken !== "string" ||
      readToken.length < 32 ||
      /\s/u.test(readToken) ||
      readToken === token)
  )
    throw new Error(
      "A read-only token must be distinct and contain at least 32 non-whitespace characters.",
    );
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
  const directory = await validateStateDirectory(stateDirectory);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "hive-mind.json");
  await readHiveMind(file);
  await readHiveConfig(file);
  const releaseOwnership = await ownStateDirectory(directory);
  try {
    await mutateHiveStore(file, (store) =>
      store.continuity
        ? [store, undefined]
        : [{ ...store, continuity: newContinuity() }, undefined],
    );
  } catch (error) {
    await releaseOwnership();
    throw error;
  }
  const engine = new HiveLocalEngine(path.join(directory, "logs"), {
    platform: process.platform,
    environment: process.env,
  });
  const runtime = new HiveMindRuntime(file, async () => engine.ensure(await readHiveConfig(file)));
  const streams = new Set();
  const respond = (response, status, result) => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify(result));
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.origin !== undefined)
        throw new RequestError(403, "Browser-origin requests are not enabled.");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.search || url.hash)
        throw new RequestError(400, "Query parameters are not supported.");
      if (request.method === "GET" && url.pathname === "/health")
        return respond(response, 200, { status: "ready", product: "Hive Mind" });
      const credential = request.headers.authorization?.match(/^Bearer (\S+)$/u)?.[1] ?? "";
      const access = matches(credential, token)
        ? "write"
        : readToken && matches(credential, readToken)
          ? "read"
          : null;
      if (!access) throw new RequestError(401, "A valid bearer token is required.");
      if (request.method === "GET" && url.pathname.startsWith("/v1/assets/")) {
        const { record, bytes } = await readBrainAsset(
          file,
          url.pathname.slice("/v1/assets/".length),
        );
        response.writeHead(200, {
          "content-type": record.data.mime,
          "content-length": bytes.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          ...(record.data.media === "file"
            ? {
                "content-disposition": "attachment",
                "x-hive-filename": encodeURIComponent(record.data.filename),
              }
            : {}),
        });
        response.end(bytes);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        const head = await brainChanges(file);
        const lastId = request.headers["last-event-id"];
        const parts = typeof lastId === "string" ? lastId.split(":") : [];
        if (parts.length > 2) throw new RequestError(400, "Invalid change cursor.");
        let cursor = lastId === undefined ? head.sequence : Number(parts.at(-1));
        const initial = await brainChanges(file, cursor, parts.length === 2 ? parts[0] : undefined);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(
          `event: ready\ndata: ${JSON.stringify({ streamId: initial.streamId, sequence: initial.sequence })}\n\n`,
        );
        let running = false;
        let dirty = true;
        const pump = async () => {
          dirty = true;
          if (running) return;
          running = true;
          try {
            while (dirty && !response.destroyed) {
              dirty = false;
              const changes = await brainChanges(file, cursor, initial.streamId);
              for (const event of changes.events) {
                cursor = event.sequence;
                if (
                  !response.write(
                    `id: ${initial.streamId}:${event.sequence}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`,
                  )
                ) {
                  response.end();
                  return; // Reconnect replays committed changes from the client's last ID.
                }
              }
            }
          } catch {
            response.end();
          } finally {
            running = false;
          }
        };
        const unsubscribe = subscribeHiveChanges(file, () => {
          void pump();
        });
        const heartbeat = setInterval(() => {
          if (!response.write(": heartbeat\n\n")) response.end();
        }, 15000);
        heartbeat.unref();
        streams.add(response);
        response.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
          streams.delete(response);
        });
        await pump();
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/status")
        return respond(response, 200, {
          ...(await runtime.snapshot()),
          continuity: {
            sequence: (await brainChanges(file)).sequence,
            records: (await readHiveMind(file)).continuity?.records.length ?? 0,
          },
        });
      if (request.method !== "POST") throw new RequestError(404, "Unknown operation.");
      if (url.pathname === "/mcp") {
        const message = await readBody(request);
        const reply = await handleMcp(message, {
          canWrite: access === "write",
          call: async (name, args) => {
            switch (name) {
              case "hive_mind_working_context":
                return brainContext(file, args);
              case "hive_mind_record": {
                const { action, ...input } = args;
                if (action === "list") return brainSnapshot(file, input);
                if (action === "save") return saveBrainRecord(file, input);
                if (action === "forget") return forgetBrainRecord(file, input);
                if (action === "claim") return claimBrainTask(file, input);
                throw new RequestError(400, "Unknown record action.");
              }
              case "hive_mind_image": {
                if (args.action === "import") {
                  const { action, ...input } = args;
                  return importBrainAsset(file, input);
                }
                if (args.action !== "read") throw new RequestError(400, "Unknown image action.");
                const { record, bytes } = await readBrainAsset(file, args.id);
                if (record.data.media === "file")
                  throw new RequestError(
                    400,
                    "Use hive_mind_file to read an opaque reference file.",
                  );
                return {
                  mcpContent: [
                    { type: "image", data: bytes.toString("base64"), mimeType: record.data.mime },
                    {
                      type: "text",
                      text: JSON.stringify({
                        id: record.id,
                        title: record.title,
                        source: record.source,
                      }),
                    },
                  ],
                };
              }
              case "hive_mind_file": {
                if (args.action === "import") {
                  const { action, ...input } = args;
                  return importBrainFile(file, input);
                }
                if (args.action !== "read") throw new RequestError(400, "Unknown file action.");
                const { record, bytes } = await readBrainAsset(file, args.id);
                return {
                  mcpContent: [
                    {
                      type: "resource",
                      resource: {
                        uri: `hive-mind://assets/${record.id}`,
                        mimeType: record.data.mime,
                        blob: bytes.toString("base64"),
                      },
                    },
                  ],
                };
              }
              case "hive_mind_recall": {
                const input = decode(HiveMindSearchInput, args);
                return recallHiveMind(file, input.query, input.project);
              }
              case "hive_mind_remember": {
                const input = decodeRemember(args);
                return {
                  memory: await rememberHiveMind(file, {
                    ...input,
                    project: input.project ?? null,
                    sourceThreadId: args.sourceThreadId ?? "hive-mind-mcp",
                  }),
                };
              }
              case "hive_mind_forget": {
                const input = decode(HiveMindMutation, { ...args, action: "forget" });
                return { removed: await forgetHiveMind(file, input.id) };
              }
              case "hive_mind_status":
                return hiveMindStatus(file);
              default:
                runtime.requestSync();
                await runtime.waitIdle();
                return runtime.snapshot();
            }
          },
        });
        if (reply === null) {
          response.writeHead(202).end();
          return;
        }
        return respond(response, 200, reply);
      }
      const operations = new Set([
        "/v1/graph",
        "/v1/memory",
        "/v1/context",
        "/v1/search",
        "/v1/remember",
        "/v1/edit",
        "/v1/forget",
        "/v1/configure",
        "/v1/sync",
        "/v1/import",
        "/v1/brain",
        "/v1/brain/save",
        "/v1/brain/forget",
        "/v1/tasks/claim",
        "/v1/changes",
        "/v1/working-context",
        "/v1/assets",
        "/v1/archive/export",
        "/v1/archive/import",
        "/v1/files",
        "/v1/visual-search",
      ]);
      if (!operations.has(url.pathname)) throw new RequestError(404, "Unknown operation.");
      if (access !== "write" && !readOperations.has(url.pathname))
        throw new RequestError(403, "This token has read-only access.");
      const body = await readBody(
        request,
        url.pathname === "/v1/assets"
          ? 14 * 1024 * 1024 + 4096
          : url.pathname === "/v1/files"
            ? 35 * 1024 * 1024 + 4096
            : url.pathname === "/v1/archive/import"
              ? 64 * 1024 * 1024
              : MAX_BODY,
      );
      let result;
      switch (url.pathname) {
        case "/v1/brain":
          result = await brainSnapshot(file, body);
          break;
        case "/v1/brain/save":
          result = await saveBrainRecord(file, body);
          break;
        case "/v1/brain/forget":
          result = await forgetBrainRecord(file, body);
          break;
        case "/v1/tasks/claim":
          result = await claimBrainTask(file, body);
          break;
        case "/v1/changes":
          result = await brainChanges(file, body.after, body.streamId);
          break;
        case "/v1/working-context":
          result = await brainContext(file, body);
          break;
        case "/v1/assets":
          result = await importBrainAsset(file, body);
          break;
        case "/v1/files":
          result = await importBrainFile(file, body);
          break;
        case "/v1/visual-search":
          result = await visualBrainSearch(file, body);
          break;
        case "/v1/archive/export":
          result = await exportBrain(file);
          break;
        case "/v1/archive/import":
          result = await restoreBrain(file, body);
          runtime.requestSync();
          break;
        case "/v1/graph":
          result = await hiveGraph(file);
          break;
        case "/v1/memory": {
          result = await hiveMemoryDetail(file, String(body.id ?? ""));
          if (!result) throw new RequestError(404, "No such record.");
          break;
        }
        case "/v1/context":
          // Prompt-ready background notes for the caller's current project(s).
          result = {
            context: hiveContext(
              file,
              String(body.query ?? ""),
              Array.isArray(body.projects) ? body.projects.map(String) : [],
            ),
          };
          break;
        case "/v1/search": {
          const input = decode(HiveMindSearchInput, body);
          result = await recallHiveMind(file, input.query, input.project);
          result.memories = result.memories.map((memory) => ({
            ...memory,
            revision: hiveMemoryDigest(memory),
          }));
          break;
        }
        case "/v1/remember": {
          const input = decodeRemember(body);
          const memory = await rememberHiveMind(file, {
            ...input,
            project: input.project ?? null,
            // Connected apps may name the chat a memory came from, for provenance.
            sourceThreadId:
              typeof body.sourceThreadId === "string" &&
              /^[\w:.-]{1,128}$/u.test(body.sourceThreadId)
                ? body.sourceThreadId
                : "hive-mind-api",
          });
          result = { memory: { ...memory, revision: hiveMemoryDigest(memory) } };
          break;
        }
        case "/v1/edit": {
          const input = decode(HiveMindMutation, { ...body, action: "edit" });
          try {
            await editHiveFact(file, input.id, input.revision, input.fact, "hive-mind-api");
          } catch (error) {
            if (String(error.message).includes("changed or was forgotten"))
              throw new RequestError(
                409,
                "The record changed or was forgotten. Recall its current revision.",
              );
            throw new RequestError(400, "The edit could not be applied.");
          }
          runtime.requestSync();
          result = await runtime.snapshot();
          break;
        }
        case "/v1/forget": {
          const input = decode(HiveMindMutation, { ...body, action: "forget" });
          result = { removed: await forgetHiveMind(file, input.id) };
          break;
        }
        case "/v1/configure":
          result = await runtime.configure(decode(HiveMindConfig, body));
          break;
        case "/v1/import": {
          const input = decode(HiveMindImportInput, body);
          result = await importHiveHindsight(file, input.url, input.bank);
          break;
        }
        case "/v1/sync":
          runtime.requestSync();
          await runtime.waitIdle();
          result = await runtime.snapshot();
          break;
      }
      respond(response, 200, result);
    } catch (error) {
      const status =
        error instanceof RequestError || error instanceof BrainError ? error.status : 400;
      if (!response.headersSent && !response.destroyed)
        respond(response, status, {
          error:
            error instanceof RequestError || error instanceof BrainError
              ? error.message
              : "Operation failed; existing records are preserved.",
        });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    await runtime.automatic();
  } catch (error) {
    await runtime.close();
    await releaseOwnership();
    throw error;
  }
  const timer = setInterval(() => {
    void runtime.automatic();
  }, 30000);
  timer.unref();
  let closing;
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stateDirectory: directory,
    onStatusChange: (listener) => runtime.onStatusChange(listener),
    close() {
      return (closing ??= (async () => {
        clearInterval(timer);
        for (const stream of streams) stream.end();
        const stopped = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeIdleConnections();
        await stopped;
        await runtime.close();
        await releaseOwnership();
      })());
    },
  };
}
