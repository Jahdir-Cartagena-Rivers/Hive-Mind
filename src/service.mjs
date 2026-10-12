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
import { readHiveMind, hiveContext, hiveMemoryDigest, editHiveFact } from "./core/store.ts";
import { importHiveHindsight } from "./core/importHindsight.ts";
import { HiveLocalEngine } from "./core/localEngine.ts";
import { readHiveConfig } from "./core/config.ts";

const MAX_BODY = 64 * 1024;
const readOperations = new Set(["/v1/search", "/v1/graph", "/v1/memory", "/v1/context"]);
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

async function readBody(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new RequestError(415, "Use application/json.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RequestError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  const engine = new HiveLocalEngine(path.join(directory, "logs"), {
    platform: process.platform,
    environment: process.env,
  });
  const runtime = new HiveMindRuntime(file, async () => engine.ensure(await readHiveConfig(file)));
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
      if (request.method === "GET" && url.pathname === "/v1/status")
        return respond(response, 200, await runtime.snapshot());
      if (request.method !== "POST") throw new RequestError(404, "Unknown operation.");
      if (url.pathname === "/mcp") {
        const message = await readBody(request);
        const reply = await handleMcp(message, {
          canWrite: access === "write",
          call: async (name, args) => {
            switch (name) {
              case "hive_mind_recall": {
                const input = decode(HiveMindSearchInput, args);
                return recallHiveMind(file, input.query, input.project);
              }
              case "hive_mind_remember": {
                const input = decode(HiveMindMutation, { ...args, action: "remember" });
                return {
                  memory: await rememberHiveMind(file, {
                    ...input,
                    project: input.project ?? null,
                    sourceThreadId: "hive-mind-mcp",
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
      ]);
      if (!operations.has(url.pathname)) throw new RequestError(404, "Unknown operation.");
      if (access !== "write" && !readOperations.has(url.pathname))
        throw new RequestError(403, "This token has read-only access.");
      const body = await readBody(request);
      let result;
      switch (url.pathname) {
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
          const input = decode(HiveMindMutation, { ...body, action: "remember" });
          const memory = await rememberHiveMind(file, {
            ...input,
            project: input.project ?? null,
            sourceThreadId: "hive-mind-api",
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
      const status = error instanceof RequestError ? error.status : 400;
      if (!response.headersSent && !response.destroyed)
        respond(response, status, {
          error:
            error instanceof RequestError
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
    close() {
      return (closing ??= (async () => {
        clearInterval(timer);
        const stopped = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeIdleConnections();
        await stopped;
        await runtime.close();
      })());
    },
  };
}
