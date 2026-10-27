#!/usr/bin/env node
// Composio REST (v3) Google Drive transport for CloudJournal-style list/read/create.
// - Credential: COMPOSIO_API_KEY from env only; never logged, never placed in URLs/argv.
// - No Google OAuth token is ever requested or exported; Composio executes Drive calls server-side.
// - create() is create-only: refuses if the name already exists in the folder, never updates/overwrites.
// Request shapes derive from GET /api/v3/tools/<SLUG>?toolkit_versions=latest (retained staging evidence)
// and https://docs.composio.dev/reference/v3/api-reference/files/postFilesUploadRequest.
import { createHash } from "node:crypto";

export const BASE = "https://backend.composio.dev/api/v3";
export const TOOL_VERSION = "20261022_00"; // pinned; v3 would otherwise default to 00000000_00

const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const ID = /^[A-Za-z0-9_-]{10,200}$/u;
const FILE_FIELDS = "id,name,parents,size,md5Checksum,mimeType,createdTime,modifiedTime,trashed";
const MAX_UPLOAD = 5 * 1024 * 1024; // GOOGLEDRIVE_UPLOAD_FILE limit
const TOOLS = new Set(['GOOGLEDRIVE_GET_FILE_METADATA', 'GOOGLEDRIVE_FIND_FILE', 'GOOGLEDRIVE_DOWNLOAD_FILE', 'GOOGLEDRIVE_UPLOAD_FILE']);
function storageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      !['amazonaws.com', 'r2.cloudflarestorage.com', 'blob.core.windows.net', 'composio.dev'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)))
    throw new TransportError('Unrecognized Composio storage destination.');
  return url;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => createHash("md5").update(b).digest("hex");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const quote = (s) => `'${String(s).replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;

export class TransportError extends Error {
  constructor(message, { status, slug, transient = false, logId } = {}) {
    super(message);
    this.status = status;
    this.slug = slug;
    this.transient = transient;
    this.logId = logId;
  }
}

export class ComposioDriveTransport {
  constructor({ apiKey = process.env.COMPOSIO_API_KEY, userId,
    connectedAccountId, fetchImpl = fetch, retries = 0, log = () => {} } = {}) {
    if (typeof apiKey !== "string" || apiKey.length < 8 || /\s/u.test(apiKey)) throw new TransportError("COMPOSIO_API_KEY is not available.");
    if (apiKey.startsWith('ck_')) throw new TransportError('This transport requires a Platform project key; For You consumer keys use MCP.');
    if (typeof userId !== 'string' || !userId || userId.length > 200 || /\s/u.test(userId) || typeof connectedAccountId !== 'string' || !ID.test(connectedAccountId))
      throw new TransportError('Explicit Composio user and connected Drive account IDs are required.');
    if (!Number.isInteger(retries) || retries < 0 || retries > 2) throw new TransportError('Invalid retry limit.');
    const key = apiKey; // closure only; not an enumerable property, so it never appears in JSON/inspect output
    this.headers = () => ({ "x-api-key": key, "content-type": "application/json" });
    this.userId = userId;
    this.connectedAccountId = connectedAccountId;
    this.fetch = fetchImpl;
    this.retries = retries;
    this.log = log; // receives {op, slug, status, attempt}; never secrets, URLs or bodies
    this.calls = [];
  }

  async #http(op, url, init, { retry = true, slug } = {}) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await this.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(45_000) });
      } catch (error) {
        const e = new TransportError(`${op}: network error (${error?.name ?? "Error"})`, { slug, transient: true });
        if (!retry || attempt > this.retries) throw e;
        this.log({ op, slug, status: "network", attempt });
        await sleep(400 * 2 ** attempt);
        continue;
      }
      this.calls.push({ op, slug, status: response.status });
      this.log({ op, slug, status: response.status, attempt });
      if (response.ok) return response;
      await response.body?.cancel().catch(() => {});
      const transient = TRANSIENT.has(response.status);
      if (!transient || !retry || attempt > this.retries)
        throw new TransportError(`${op}: HTTP ${response.status}`, { status: response.status, slug, transient });
      const after = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 400 * 2 ** attempt);
    }
  }

  /** POST /tools/execute/<slug>; returns `data` when successful. */
  async execute(slug, args, { retry = true } = {}) {
    if (!TOOLS.has(slug)) throw new TransportError('Unsupported Drive transport tool.');
    const response = await this.#http("execute", `${BASE}/tools/execute/${slug}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ connected_account_id: this.connectedAccountId, user_id: this.userId,
        version: TOOL_VERSION, arguments: args }),
    }, { retry: slug === 'GOOGLEDRIVE_UPLOAD_FILE' ? false : retry, slug });
    const body = await response.json();
    const logId = typeof body?.log_id === 'string' && /^log_[A-Za-z0-9_-]{1,100}$/u.test(body.log_id) ? body.log_id : undefined;
    if (logId) this.lastLogId = logId;
    if (body?.successful !== true) {
      // Provider bodies can echo secrets or signed URLs. Never copy them into logs/errors.
      throw new TransportError('Composio tool execution failed; inspect the provider log privately.', { status: response.status, slug, logId });
    }
    return body.data;
  }

  async metadata(fileId) {
    if (typeof fileId !== 'string' || !ID.test(fileId)) throw new TransportError("Invalid Drive file ID.");
    const metadata = await this.execute("GOOGLEDRIVE_GET_FILE_METADATA", { fileId, fields: FILE_FIELDS });
    if (metadata?.id !== fileId) throw new TransportError('Drive metadata identity changed.');
    return metadata;
  }

  /** All non-trashed children of folderId (paginated), optionally filtered by exact name. */
  async list(folderId, { name } = {}) {
    if (typeof folderId !== 'string' || !ID.test(folderId)) throw new TransportError("Invalid Drive folder ID.");
    const files = [];
    const seen = new Set();
    const seenTokens = new Set();
    let pageToken;
    for (let page = 0; page < 1000; page++) {
      const q = `${quote(folderId)} in parents and trashed = false${name === undefined ? "" : ` and name = ${quote(name)}`}`;
      const data = await this.execute("GOOGLEDRIVE_FIND_FILE", {
        q, fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`, pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      });
      if (data?.incompleteSearch) throw new TransportError("Drive reported an incomplete search.");
      if (!Array.isArray(data?.files)) throw new TransportError('Drive returned a malformed file list.');
      for (const f of data.files) {
        if (typeof f?.id !== 'string' || !ID.test(f.id) || typeof f.name !== 'string' || !Array.isArray(f.parents)) throw new TransportError('Drive returned malformed file metadata.');
        if (seen.has(f.id)) throw new TransportError("Drive returned a repeated file across pages.");
        if (!f.parents.includes(folderId)) throw new TransportError('Drive returned a file outside the requested folder.');
        seen.add(f.id);
        files.push(f);
        if (files.length > 10000) throw new TransportError('Drive folder exceeds the file limit.');
      }
      if (!data?.nextPageToken) return files;
      if (typeof data.nextPageToken !== 'string' || seenTokens.has(data.nextPageToken)) throw new TransportError("Drive repeated or malformed a page token.");
      seenTokens.add(data.nextPageToken);
      pageToken = data.nextPageToken;
    }
    throw new TransportError("Drive listing exceeded the page limit.");
  }

  /** Download exact bytes; verifies against Drive md5Checksum and size. */
  async read(fileId, { expectedSha256, folderId } = {}) {
    const meta = await this.metadata(fileId);
    if (folderId && !(meta.parents ?? []).includes(folderId)) throw new TransportError('Drive read is outside the configured folder.');
    if (!Number.isSafeInteger(Number(meta.size)) || Number(meta.size) < 0 || Number(meta.size) > MAX_UPLOAD ||
        !/^[a-f0-9]{32}$/u.test(meta.md5Checksum ?? '')) throw new TransportError('Drive blob metadata exceeds bounds or lacks integrity data.');
    const data = await this.execute("GOOGLEDRIVE_DOWNLOAD_FILE", { fileId });
    const ref = data?.downloaded_file_content;
    if (data?.export_applied || data?.export_size_limit_exceeded || typeof ref?.s3url !== "string")
      throw new TransportError("Download did not return native file content.");
    const url = storageUrl(ref.s3url);
    const response = await this.#http("fetch-download", url, { method: "GET" }, { slug: "s3url" });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw new TransportError('Composio blob exceeds the bounded download limit.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (meta.size !== undefined && Number(meta.size) !== bytes.length)
      throw new TransportError("Downloaded length does not match Drive size.");
    if (meta.md5Checksum && meta.md5Checksum !== md5(bytes))
      throw new TransportError("Downloaded bytes do not match Drive md5Checksum.");
    if (expectedSha256 && expectedSha256 !== sha256(bytes))
      throw new TransportError("Downloaded bytes do not match expected sha256.");
    return bytes;
  }

  /** Stage bytes with Composio (presigned PUT), then GOOGLEDRIVE_UPLOAD_FILE. Never overwrites. */
  async create(folderId, name, buffer, { mimetype = "application/octet-stream" } = {}) {
    if (typeof folderId !== 'string' || !ID.test(folderId)) throw new TransportError("Invalid Drive folder ID.");
    if (typeof name !== "string" || !name || name.length > 255 || /[\\/\u0000-\u001f]/u.test(name))
      throw new TransportError("Invalid file name.");
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_UPLOAD)
      throw new TransportError("Buffer must be 1 byte to 5 MiB for GOOGLEDRIVE_UPLOAD_FILE.");
    const folder = await this.metadata(folderId);
    if (folder.mimeType !== "application/vnd.google-apps.folder" || folder.trashed)
      throw new TransportError("Target is not an active Drive folder."); // upload would silently fall back to root
    if ((await this.list(folderId, { name })).length)
      throw new TransportError("A file with this name already exists; create-only transport refuses to overwrite.");
    const digest = md5(buffer);
    const staging = await this.#http("files-upload-request", `${BASE}/files/upload/request`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ toolkit_slug: "googledrive", tool_slug: "GOOGLEDRIVE_UPLOAD_FILE",
        filename: name, mimetype, md5: digest }),
    }, { retry: false }).then((r) => r.json());
    if (typeof staging?.key !== "string")
      throw new TransportError("Composio did not return a staging key.");
    if (staging.type !== 'existing') {
      const put = storageUrl(staging.new_presigned_url);
      await this.#http("presigned-put", put, {
      method: "PUT", body: buffer,
      headers: { "content-type": mimetype, "content-length": String(buffer.length),
        ...(staging.metadata?.storage_backend === "azure_blob_storage" ? { "x-ms-blob-type": "BlockBlob" } : {}) },
      }, { slug: "presigned-put", retry: false });
    }
    const args = { file_to_upload: { name, mimetype, s3key: staging.key }, folder_to_upload_to: folderId };
    let data;
    try {
      // No blind retry: an uncertain upload could already have created the file.
      data = await this.execute("GOOGLEDRIVE_UPLOAD_FILE", args, { retry: false });
    } catch (error) {
      if (!error.transient) throw error;
      const landed = await this.list(folderId, { name });
      if (landed.length === 1 && landed[0].md5Checksum === digest && Number(landed[0].size) === buffer.length) data = landed[0];
      else throw new TransportError("Uncertain upload outcome; manual reconciliation required.");
    }
    const meta = await this.metadata(data.id);
    if (!(meta.parents ?? []).includes(folderId)) throw new TransportError("Uploaded file is not in the target folder.");
    if (meta.name !== name) throw new TransportError('Uploaded file name changed.');
    if (meta.md5Checksum !== digest || Number(meta.size) !== buffer.length)
      throw new TransportError("Uploaded file integrity mismatch.");
    return { id: meta.id, md5: meta.md5Checksum, name: meta.name, size: Number(meta.size),
      parents: meta.parents, createdTime: meta.createdTime };
  }
}

/** Folder-bound adapter for CloudJournal. Account IDs are configuration, never hardcoded defaults. */
export function createTransport({ folderId, userId, connectedAccountId, fetchImpl = fetch } = {}) {
  if (typeof folderId !== 'string' || !ID.test(folderId)) throw new TransportError('A private Drive folder ID is required.');
  const transport = new ComposioDriveTransport({ userId, connectedAccountId, fetchImpl });
  return { list: () => transport.list(folderId), read: id => transport.read(id, { folderId }),
    create: (name, bytes) => transport.create(folderId, name, bytes) };
}
