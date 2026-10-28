// Composio proxy transport bound to ONE native binary Google Drive file.
// - Credential: COMPOSIO_API_KEY read from the environment at call time only; never stored, logged or returned.
// - Bindings (user, connected account, folder, file, expected name) are explicit options; no defaults.
// - write() is a conditional (If-Match) resumable update in 1 MiB chunks; uncertain mutations are never replayed.
// - Errors carry static, safe messages only: no provider bodies, URLs (resumable Location, signed storage URLs) or keys.
// Proxy shape: POST https://backend.composio.dev/api/v3/tools/execute/proxy
//   {endpoint, method, connected_account_id, user_id, body?, binary_body?, parameters?} -> {data, binary_data, status, headers}
//   (https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteProxy).
// Revisions: https://developers.google.com/drive/api/reference/rest/v3/revisions
import { createHash } from 'node:crypto';

export const PROXY_URL = 'https://backend.composio.dev/api/v3/tools/execute/proxy';
export const CHUNK_SIZE = 1024 * 1024; // 1 MiB (multiple of 256 KiB as required by Drive resumable uploads)
export const MAX_FILE_BYTES = 90 * 1024 * 1024;
export const HTTP_TIMEOUT_MS = 45_000;
export const MAX_PURGE_IDS = 200;
export const MAX_REVISION_PAGES = 50;

const DRIVE = 'https://www.googleapis.com';
const META_FIELDS = 'id,title,etag,fileSize,md5Checksum,mimeType,parents,headRevisionId,labels(trashed)';
const REVISION_FIELDS = 'nextPageToken,revisions(id,modifiedTime,size,md5Checksum,keepForever)';
const OCTET = 'application/octet-stream';
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/u;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const REVISION_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const MD5 = /^[a-f0-9]{32}$/u;
// Same bounded storage-host allowlist as composio-drive-transport.mjs storageUrl().
const STORAGE_HOSTS = ['amazonaws.com', 'r2.cloudflarestorage.com', 'blob.core.windows.net', 'composio.dev'];

const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');

export class DriveFileError extends Error {
  constructor(message, { code = 'ERR_DRIVE_FILE_PROVIDER', status, uncertain = false, phase, results } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (status !== undefined) this.status = status;
    this.uncertain = uncertain; // true: the mutation may or may not have applied; reconcile by reading, never replay blindly
    if (phase) this.phase = phase;
    if (results) this.results = results;
  }
}
export class DriveFileConfigError extends DriveFileError { constructor(m, o = {}) { super(m, { ...o, code: 'ERR_DRIVE_FILE_CONFIG' }); } }
export class DriveFileBindingError extends DriveFileError { constructor(m, o = {}) { super(m, { ...o, code: 'ERR_DRIVE_FILE_BINDING' }); } }
export class DriveFileConflictError extends DriveFileError { constructor(m, o = {}) { super(m, { ...o, code: 'ERR_DRIVE_FILE_CONFLICT' }); } }
export class DriveFileIntegrityError extends DriveFileError { constructor(m, o = {}) { super(m, { ...o, code: 'ERR_DRIVE_FILE_INTEGRITY' }); } }
export class DriveFileProviderError extends DriveFileError { constructor(m, o = {}) { super(m, { ...o, code: 'ERR_DRIVE_FILE_PROVIDER' }); } }
export class DriveFileUncertainError extends DriveFileError { constructor(m, o = {}) { super(m, { ...o, uncertain: true, code: 'ERR_DRIVE_FILE_UNCERTAIN' }); } }
export class DriveFileAmbiguousError extends DriveFileError { constructor(m, o = {}) { super(m, { ...o, uncertain: true, code: 'ERR_DRIVE_FILE_AMBIGUOUS' }); } }

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const v = Array.isArray(value) ? value[0] : value;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function storageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new DriveFileProviderError('Unrecognized Composio storage destination.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      !STORAGE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith('.' + host)))
    throw new DriveFileProviderError('Unrecognized Composio storage destination.');
  return url;
}

function sessionUrl(value, fileId) {
  let url;
  try { url = new URL(value); } catch { throw new DriveFileProviderError('Resumable session location is invalid.', { phase: 'init' }); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.googleapis.com' || (url.port && url.port !== '443') ||
      url.username || url.password || url.hash || value.includes('#') || url.pathname !== `/upload/drive/v2/files/${fileId}` ||
      url.searchParams.getAll('upload_id').length !== 1 || !url.searchParams.get('upload_id'))
    throw new DriveFileProviderError('Resumable session location is invalid.', { phase: 'init' });
  return url.href;
}

function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\\/\u0000-\u001f\u007f]/u.test(name);
}
function validEtag(etag) {
  return typeof etag === 'string' && etag.length > 0 && etag.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(etag);
}

export class ComposioDriveFile {
  #userId; #accountId; #folderId; #fileId; #name; #fetch; #timeoutMs;

  constructor({ userId, connectedAccountId, folderId, fileId, expectedName, fetchImpl, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
    if (typeof userId !== 'string' || !userId || userId.length > 200 || /\s/u.test(userId))
      throw new DriveFileConfigError('An explicit Composio user ID is required.');
    if (typeof connectedAccountId !== 'string' || !ACCOUNT_ID.test(connectedAccountId))
      throw new DriveFileConfigError('An explicit Composio connected account ID is required.');
    if (typeof folderId !== 'string' || !DRIVE_ID.test(folderId)) throw new DriveFileConfigError('An explicit Drive folder ID is required.');
    if (typeof fileId !== 'string' || !DRIVE_ID.test(fileId) || fileId === folderId) throw new DriveFileConfigError('An explicit Drive file ID is required.');
    if (!validName(expectedName)) throw new DriveFileConfigError('An explicit expected file name is required.');
    if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new DriveFileConfigError('fetchImpl must be a function.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HTTP_TIMEOUT_MS) throw new DriveFileConfigError('Invalid HTTP timeout.');
    this.#userId = userId; this.#accountId = connectedAccountId; this.#folderId = folderId;
    this.#fileId = fileId; this.#name = expectedName; this.#fetch = fetchImpl ?? fetch; this.#timeoutMs = timeoutMs;
  }

  // Never expose bindings or internals through inspection/serialization.
  toJSON() { return { type: 'ComposioDriveFile' }; }

  #key() {
    const key = process.env.COMPOSIO_API_KEY;
    if (typeof key !== 'string' || key.length < 8 || /\s/u.test(key)) throw new DriveFileConfigError('COMPOSIO_API_KEY is not available.');
    if (key.startsWith('ck_')) throw new DriveFileConfigError('This transport requires a Platform project key.');
    return key;
  }

  /**
   * One proxy call. Returns {status, data, binary, headers} with the upstream status.
   * mutating: network/timeout/malformed outcomes become DriveFileUncertainError (never replayed).
   */
  async #proxy({ endpoint, method, body, binaryBody, parameters }, { mutating = false, phase } = {}) {
    const key = this.#key();
    const payload = { endpoint, method, connected_account_id: this.#accountId, user_id: this.#userId };
    if (body !== undefined) payload.body = body;
    if (binaryBody !== undefined) payload.binary_body = binaryBody;
    if (parameters?.length) payload.parameters = parameters;
    const fail = (message, extra = {}) => mutating
      ? new DriveFileUncertainError(message, { phase, ...extra })
      : new DriveFileProviderError(message, { phase, ...extra });
    let response;
    try {
      response = await this.#fetch(PROXY_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (error) {
      throw fail(`Drive proxy ${phase ?? 'request'} failed (${error?.name === 'TimeoutError' ? 'timeout' : 'network'}).`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw fail(`Drive proxy request failed (HTTP ${response.status}).`, { status: response.status });
    }
    let envelope;
    try {
      const chunks = []; let length = 0;
      const limit = phase === 'download' ? MAX_FILE_BYTES + 1024 * 1024 : 1024 * 1024;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > limit) { await response.body?.cancel().catch(() => {}); throw new Error(); }
        chunks.push(chunk);
      }
      envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { envelope = undefined; }
    const status = Number.isInteger(envelope?.status) ? envelope.status : (response.ok ? undefined : response.status);
    if (!Number.isInteger(status)) throw fail(`Drive proxy ${phase ?? 'request'} returned a malformed response.`, { status: response.status });
    let data = envelope?.data;
    return { status, data, binary: envelope?.binary_data, headers: envelope?.headers };
  }

  #metadataEndpoint() { return `${DRIVE}/drive/v2/files/${this.#fileId}?fields=${META_FIELDS}`; }

  /** Fetch v2 metadata and verify the exact binding. Never mutates. */
  async #metadata(phase = 'metadata') {
    const r = await this.#proxy({ endpoint: this.#metadataEndpoint(), method: 'GET' }, { phase });
    if (r.status === 404) throw new DriveFileBindingError('Bound Drive file was not found.', { status: 404, phase });
    if (r.status !== 200) throw new DriveFileProviderError(`Drive metadata request failed (HTTP ${r.status}).`, { status: r.status, phase });
    const m = typeof r.data === 'string' ? safeJson(r.data) : r.data;
    if (!m || typeof m !== 'object') throw new DriveFileProviderError('Drive metadata was malformed.', { phase });
    if (m.id !== this.#fileId) throw new DriveFileBindingError('Drive file identity does not match the binding.', { phase });
    if (m.labels?.trashed === true) throw new DriveFileBindingError('Bound Drive file is in trash.', { phase });
    if (m.title !== this.#name) throw new DriveFileBindingError('Drive file name does not match the binding.', { phase });
    if (!Array.isArray(m.parents) || !m.parents.some((p) => p && typeof p === 'object' && p.id === this.#folderId))
      throw new DriveFileBindingError('Drive file is not in the bound folder.', { phase });
    if (typeof m.mimeType !== 'string' || !m.mimeType || m.mimeType.startsWith('application/vnd.google-apps.'))
      throw new DriveFileBindingError('Drive file is not native binary content.', { phase });
    if (!validEtag(m.etag)) throw new DriveFileProviderError('Drive metadata lacks an ETag.', { phase });
    const size = m.fileSize === undefined ? NaN : Number(m.fileSize);
    if (!Number.isSafeInteger(size) || size < 0 || String(m.fileSize).trim() === '')
      throw new DriveFileIntegrityError('Drive metadata lacks a valid file size.', { phase });
    if (size > MAX_FILE_BYTES) throw new DriveFileIntegrityError('Drive file exceeds the bounded size limit.', { phase });
    if (m.md5Checksum !== undefined && !MD5.test(m.md5Checksum)) throw new DriveFileIntegrityError('Drive metadata has a malformed checksum.', { phase });
    if (size > 0 && m.md5Checksum === undefined) throw new DriveFileIntegrityError('Drive metadata lacks an MD5 checksum.', { phase });
    if (m.headRevisionId !== undefined && (typeof m.headRevisionId !== 'string' || !REVISION_ID.test(m.headRevisionId)))
      throw new DriveFileProviderError('Drive metadata has a malformed head revision.', { phase });
    if (size > 0 && m.headRevisionId === undefined) throw new DriveFileProviderError('Drive metadata lacks a head revision.', { phase });
    return { etag: m.etag, size, md5: m.md5Checksum, revisionId: m.headRevisionId ?? null };
  }

  async #download(response, expectedSize) {
    const declared = response.binary?.size;
    if (declared !== undefined && declared !== null && Number(declared) !== expectedSize)
      throw new DriveFileIntegrityError('Downloaded length does not match Drive size.', { phase: 'download' });
    const url = storageUrl(response.binary.url);
    let r;
    try {
      // No headers at all: the project key and any Drive auth never reach storage.
      r = await this.#fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      throw new DriveFileProviderError(`Storage download failed (${error?.name === 'TimeoutError' ? 'timeout' : 'network'}).`, { phase: 'download' });
    }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new DriveFileProviderError(`Storage download failed (HTTP ${r.status}).`, { status: r.status, phase: 'download' }); }
    const length = Number(r.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > expectedSize) {
      await r.body?.cancel().catch(() => {});
      throw new DriveFileIntegrityError('Downloaded length exceeds Drive size.', { phase: 'download' });
    }
    const chunks = []; let size = 0;
    try {
      if (r.body) for await (const chunk of r.body) {
        size += chunk.length;
        if (size > expectedSize || size > MAX_FILE_BYTES) throw new DriveFileIntegrityError('Downloaded length exceeds Drive size.', { phase: 'download' });
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof DriveFileError) throw error;
      throw new DriveFileProviderError('Storage download was interrupted.', { phase: 'download' });
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  /** read() -> {bytes: Buffer|null, etag, revisionId}; bytes is null only for an empty initial file. */
  async read({ etag } = {}) {
    if (etag !== undefined && !validEtag(etag)) throw new DriveFileConfigError('Invalid cached Drive ETag.');
    const before = await this.#metadata('read-metadata');
    if (before.size === 0) {
      if (before.md5 !== undefined && before.md5 !== EMPTY_MD5) throw new DriveFileIntegrityError('Empty Drive file has a non-empty checksum.');
      return { bytes: null, etag: before.etag, revisionId: before.revisionId };
    }
    if (etag === before.etag) return { unchanged: true, etag: before.etag, revisionId: before.revisionId };
    const r = await this.#proxy({ endpoint: `${DRIVE}/drive/v3/files/${this.#fileId}?alt=media`, method: 'GET' }, { phase: 'download' });
    if (r.status !== 200) throw new DriveFileProviderError(`Drive content request failed (HTTP ${r.status}).`, { status: r.status, phase: 'download' });
    let bytes;
    if (r.binary && typeof r.binary === 'object' && typeof r.binary.url === 'string') {
      bytes = await this.#download(r, before.size);
    } else {
      // Inline data is accepted only when an exact serialization reproduces Drive's MD5 and size.
      const candidates = typeof r.data === 'string' ? [Buffer.from(r.data, 'utf8'), Buffer.from(r.data, 'latin1')]
        : (r.data !== undefined && r.data !== null ? [Buffer.from(JSON.stringify(r.data), 'utf8')] : []);
      bytes = candidates.find((c) => c.length === before.size && md5(c) === before.md5);
      if (!bytes) throw new DriveFileIntegrityError('Inline Drive content does not match Drive md5Checksum.', { phase: 'download' });
    }
    if (bytes.length !== before.size) throw new DriveFileIntegrityError('Downloaded length does not match Drive size.', { phase: 'download' });
    if (md5(bytes) !== before.md5) throw new DriveFileIntegrityError('Downloaded bytes do not match Drive md5Checksum.', { phase: 'download' });
    const after = await this.#metadata('read-recheck');
    if (after.etag !== before.etag || after.revisionId !== before.revisionId || after.md5 !== before.md5)
      throw new DriveFileAmbiguousError('Drive file changed during read; retry the read.', { phase: 'read-recheck' });
    return { bytes, etag: before.etag, revisionId: before.revisionId };
  }

  /** write(bytes, {etag}) -> {etag, revisionId}: conditional resumable update, never replayed. */
  async write(bytes, { etag } = {}) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new DriveFileConfigError('write() requires a Buffer.');
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!validEtag(etag)) throw new DriveFileConfigError('write() requires the ETag returned by read().');
    if (data.length === 0) throw new DriveFileConfigError('Zero-length writes are not supported.');
    if (data.length > MAX_FILE_BYTES) throw new DriveFileConfigError('write() payload exceeds the 90 MiB limit.');
    this.#key();
    const total = data.length, digest = md5(data);

    const current = await this.#metadata('write-precheck');
    if (current.etag !== etag) throw new DriveFileConflictError('Drive file changed since it was read.', { status: 412, phase: 'write-precheck' });

    const init = await this.#proxy({
      endpoint: `${DRIVE}/upload/drive/v2/files/${this.#fileId}?uploadType=resumable`, method: 'PUT',
      body: { mimeType: OCTET },
      parameters: [
        { name: 'If-Match', type: 'header', value: etag },
        { name: 'X-Upload-Content-Type', type: 'header', value: OCTET },
        { name: 'X-Upload-Content-Length', type: 'header', value: String(total) },
      ],
    }, { mutating: true, phase: 'init' });
    if (init.status === 412) throw new DriveFileConflictError('Drive file changed since it was read.', { status: 412, phase: 'init' });
    if (init.status !== 200) throw new DriveFileUncertainError(`Resumable session init failed (HTTP ${init.status}).`, { status: init.status, phase: 'init' });
    const rawLocation = header(init.headers, 'location');
    if (typeof rawLocation !== 'string') throw new DriveFileProviderError('Resumable session location is missing.', { phase: 'init' });
    const location = sessionUrl(rawLocation, this.#fileId); // local only; never logged, returned or placed in errors

    let final;
    for (let start = 0; start < total; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, total) - 1, last = end === total - 1;
      const phase = last ? 'final-chunk' : 'chunk';
      const r = await this.#proxy({
        endpoint: location, method: 'PUT',
        binaryBody: { base64: data.subarray(start, end + 1).toString('base64'), content_type: OCTET },
        parameters: [
          { name: 'Content-Range', type: 'header', value: `bytes ${start}-${end}/${total}` },
          { name: 'If-Match', type: 'header', value: etag },
        ],
      }, { mutating: true, phase });
      if (r.status === 412) throw new DriveFileConflictError('Drive file changed during upload.', { status: 412, phase });
      if (!last) {
        if (r.status !== 308) throw new DriveFileUncertainError(`Unexpected upload chunk status (HTTP ${r.status}).`, { status: r.status, phase });
        const range = header(r.headers, 'range');
        if (range !== undefined && range !== `bytes=0-${end}`)
          throw new DriveFileUncertainError('Drive acknowledged an unexpected upload range.', { status: 308, phase });
        continue;
      }
      if (r.status !== 200 && r.status !== 201) throw new DriveFileUncertainError(`Unexpected final upload status (HTTP ${r.status}).`, { status: r.status, phase });
      final = typeof r.data === 'string' ? safeJson(r.data) : r.data;
    }

    if (!final || typeof final !== 'object' || final.id !== this.#fileId || final.md5Checksum !== digest || Number(final.fileSize) !== total)
      throw new DriveFileIntegrityError('Uploaded content does not match local bytes.', { uncertain: true, phase: 'verify' });
    let after;
    try { after = await this.#metadata('write-verify'); } catch (error) {
      throw new DriveFileAmbiguousError('Upload completed but the result could not be verified.', { phase: 'write-verify', status: error?.status });
    }
    if (after.md5 !== digest || after.size !== total ||
        (typeof final.headRevisionId === 'string' && final.headRevisionId !== after.revisionId) ||
        (typeof final.etag === 'string' && after.etag !== final.etag))
      throw new DriveFileAmbiguousError('Drive file changed immediately after upload.', { phase: 'write-verify' });
    return { etag: after.etag, revisionId: after.revisionId };
  }

  /**
   * Permanently delete exact obsolete revisions. Validates everything and refuses the head before any DELETE.
   * Returns [{id, result: 'deleted'|'absent'}]. On failure throws with error.results (completed, failed, skipped).
   */
  async purgeRevisions(ids) {
    if (!Array.isArray(ids) || ids.length === 0) throw new DriveFileConfigError('purgeRevisions() requires revision IDs.');
    if (ids.some((id) => typeof id !== 'string' || !REVISION_ID.test(id))) throw new DriveFileConfigError('Invalid revision ID.');
    const unique = [...new Set(ids)];
    if (unique.length > MAX_PURGE_IDS) throw new DriveFileConfigError('Too many revision IDs.');
    const head = await this.#metadata('purge-precheck');
    if (!head.revisionId || unique.includes(head.revisionId))
      throw new DriveFileConfigError('Refusing to delete the current head revision.', { phase: 'purge-precheck' });
    const results = [];
    for (let i = 0; i < unique.length; i++) {
      const id = unique[i];
      const skipped = () => unique.slice(i + 1).map((rest) => ({ id: rest, result: 'skipped' }));
      let check;
      try { check = await this.#metadata('purge-recheck'); } catch (error) {
        error.results = [...results, { id, result: 'skipped' }, ...skipped()]; throw error;
      }
      if (!check.revisionId || unique.includes(check.revisionId)) {
        throw new DriveFileConfigError('Refusing to delete the current head revision.', { phase: 'purge-recheck',
          results: [...results, { id, result: 'skipped' }, ...skipped()] });
      }
      let r;
      try {
        r = await this.#proxy({ endpoint: `${DRIVE}/drive/v3/files/${this.#fileId}/revisions/${id}`, method: 'DELETE' },
          { mutating: true, phase: 'purge' });
      } catch (error) {
        error.results = [...results, { id, result: 'uncertain' }, ...skipped()]; throw error;
      }
      if (r.status === 204) { results.push({ id, result: 'deleted' }); continue; }
      if (r.status === 404) { results.push({ id, result: 'absent' }); continue; }
      const failed = [...results, { id, result: 'failed', status: r.status }, ...skipped()];
      if (r.status === 412) throw new DriveFileConflictError('Revision deletion precondition failed.', { status: 412, phase: 'purge', results: failed });
      if (r.status >= 400 && r.status < 500)
        throw new DriveFileProviderError(`Drive refused revision deletion (HTTP ${r.status}).`, { status: r.status, phase: 'purge', results: failed });
      failed[results.length].result = 'uncertain';
      throw new DriveFileUncertainError(`Revision deletion outcome is uncertain (HTTP ${r.status}).`, { status: r.status, phase: 'purge', results: failed });
    }
    return results;
  }

  /** Diagnostic, bounded: up to maxPages pages; returns nextPageToken when more remain. */
  async listRevisions({ pageToken, pageSize = 100, maxPages = 10 } = {}) {
    if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 2048))
      throw new DriveFileConfigError('Invalid revision page token.');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new DriveFileConfigError('Invalid revision page size.');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_REVISION_PAGES) throw new DriveFileConfigError('Invalid revision page limit.');
    await this.#metadata('revisions-precheck');
    const revisions = [], seenTokens = new Set(pageToken ? [pageToken] : []), seenIds = new Set();
    let token = pageToken;
    for (let page = 0; page < maxPages; page++) {
      const query = `fields=${REVISION_FIELDS}&pageSize=${pageSize}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const r = await this.#proxy({ endpoint: `${DRIVE}/drive/v3/files/${this.#fileId}/revisions?${query}`, method: 'GET' }, { phase: 'revisions' });
      if (r.status !== 200) throw new DriveFileProviderError(`Drive revision listing failed (HTTP ${r.status}).`, { status: r.status, phase: 'revisions' });
      const body = typeof r.data === 'string' ? safeJson(r.data) : r.data;
      if (!body || !Array.isArray(body.revisions)) throw new DriveFileProviderError('Drive returned a malformed revision list.', { phase: 'revisions' });
      for (const rev of body.revisions) {
        if (!rev || typeof rev.id !== 'string' || !REVISION_ID.test(rev.id) || seenIds.has(rev.id))
          throw new DriveFileProviderError('Drive returned malformed or repeated revisions.', { phase: 'revisions' });
        seenIds.add(rev.id);
        revisions.push({ id: rev.id, modifiedTime: rev.modifiedTime, size: rev.size, md5Checksum: rev.md5Checksum, keepForever: rev.keepForever === true });
      }
      if (!body.nextPageToken) return { revisions };
      if (typeof body.nextPageToken !== 'string' || seenTokens.has(body.nextPageToken))
        throw new DriveFileProviderError('Drive repeated or malformed a revision page token.', { phase: 'revisions' });
      seenTokens.add(body.nextPageToken);
      token = body.nextPageToken;
    }
    return { revisions, nextPageToken: token };
  }
}

function safeJson(text) { try { return JSON.parse(text); } catch { return undefined; } }

/** Factory returning the bound file transport (read/write/purgeRevisions/listRevisions). */
export function createFileTransport(options) {
  const file = new ComposioDriveFile(options);
  return { read: (opts) => file.read(opts), write: (bytes, opts) => file.write(bytes, opts),
    purgeRevisions: (ids) => file.purgeRevisions(ids), listRevisions: (opts) => file.listRevisions(opts) };
}
