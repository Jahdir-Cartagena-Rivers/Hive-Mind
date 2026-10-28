import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ComposioDriveFile, createFileTransport, PROXY_URL, CHUNK_SIZE, MAX_FILE_BYTES } from '../src/composio-drive-file.mjs';

// Obviously synthetic bindings and key; nothing here is a real account, folder, file or credential.
const FAKE_KEY = 'synthetic-project-key-0000';
const folderId = 'synthetic_folder_12345', fileId = 'synthetic_file_12345', expectedName = 'synthetic-state.bin';
const options = { userId: 'synthetic-user', connectedAccountId: 'synthetic_account_123', folderId, fileId, expectedName };
const ETAG = '"synthetic-etag-1"', ETAG2 = '"synthetic-etag-2"';
const LOCATION = `https://www.googleapis.com/upload/drive/v2/files/${fileId}?uploadType=resumable&upload_id=synthetic-session-secret`;
const STORAGE = 'https://synthetic-bucket.s3.amazonaws.com/object?X-Amz-Signature=synthetic-signature';
const md5 = (b) => createHash('md5').update(b).digest('hex');
const env = (body) => Response.json(body);
const meta = (bytes, extra = {}) => ({ id: fileId, title: expectedName, etag: ETAG, fileSize: String(bytes?.length ?? 0),
  ...(bytes?.length ? { md5Checksum: md5(bytes) } : {}), mimeType: 'application/octet-stream',
  parents: [{ id: folderId, kind: 'drive#parentReference' }], headRevisionId: 'synthetic_rev_head', ...extra });

let saved;
beforeEach(() => { saved = process.env.COMPOSIO_API_KEY; process.env.COMPOSIO_API_KEY = FAKE_KEY; });
afterEach(() => { if (saved === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = saved; });

/** Fake fetch routing proxy calls by Drive endpoint/method; records every call. */
function fake(route) {
  const calls = [];
  const impl = async (url, init) => {
    const address = String(url);
    if (address === PROXY_URL) {
      assert.equal(init.method, 'POST'); assert.equal(init.headers['x-api-key'], FAKE_KEY); assert.ok(init.signal);
      const body = JSON.parse(init.body);
      assert.equal(body.user_id, options.userId); assert.equal(body.connected_account_id, options.connectedAccountId);
      const params = Object.fromEntries((body.parameters ?? []).map((p) => [p.name, p]));
      const call = { kind: 'proxy', endpoint: body.endpoint, method: body.method, body, params };
      calls.push(call);
      return route(call, calls, init);
    }
    const call = { kind: 'storage', url: address, init }; calls.push(call);
    return route(call, calls, init);
  };
  return { calls, impl };
}
const isMeta = (c) => c.kind === 'proxy' && c.method === 'GET' && c.endpoint.includes('/drive/v2/files/');
const isMedia = (c) => c.kind === 'proxy' && c.endpoint.endsWith('?alt=media');
const isInit = (c) => c.kind === 'proxy' && c.endpoint.includes('/upload/drive/v2/files/') && c.endpoint.endsWith('uploadType=resumable');
const isChunk = (c) => c.kind === 'proxy' && c.body.binary_body !== undefined;
const isDelete = (c) => c.kind === 'proxy' && c.method === 'DELETE';
const safe = (error) => {
  const text = `${error.message} ${JSON.stringify(error)} ${error.stack}`;
  for (const secret of [FAKE_KEY, 'synthetic-session-secret', 'synthetic-signature', 'private-provider-body', 'googleapis.com', 'https://'])
    assert.ok(!text.includes(secret), `error leaked ${secret}`);
  return true;
};

test('constructor requires every explicit binding and the key is read from the environment at call time', async () => {
  for (const key of Object.keys(options)) {
    assert.throws(() => new ComposioDriveFile({ ...options, [key]: undefined }), { code: 'ERR_DRIVE_FILE_CONFIG' });
    assert.throws(() => createFileTransport({ ...options, [key]: '' }), { code: 'ERR_DRIVE_FILE_CONFIG' });
  }
  assert.throws(() => new ComposioDriveFile(), { code: 'ERR_DRIVE_FILE_CONFIG' });
  assert.throws(() => new ComposioDriveFile({ ...options, expectedName: 'a/b' }), { code: 'ERR_DRIVE_FILE_CONFIG' });
  assert.throws(() => new ComposioDriveFile({ ...options, fileId: folderId }), { code: 'ERR_DRIVE_FILE_CONFIG' });
  delete process.env.COMPOSIO_API_KEY;
  const f = fake(() => assert.fail('no request expected'));
  const t = createFileTransport({ ...options, fetchImpl: f.impl });
  await assert.rejects(t.read(), (e) => e.code === 'ERR_DRIVE_FILE_CONFIG' && /COMPOSIO_API_KEY/.test(e.message));
  await assert.rejects(t.write(Buffer.from('x'), { etag: ETAG }), { code: 'ERR_DRIVE_FILE_CONFIG' });
  await assert.rejects(t.purgeRevisions(['synthetic_rev_old']), { code: 'ERR_DRIVE_FILE_CONFIG' });
  process.env.COMPOSIO_API_KEY = 'ck_synthetic-consumer';
  await assert.rejects(t.read(), { code: 'ERR_DRIVE_FILE_CONFIG' });
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(new ComposioDriveFile(options)).includes(folderId), false);
});

test('read via allowed storage URL verifies size and MD5, forwards no auth and rechecks the ETag', async () => {
  const bytes = Buffer.from('synthetic encrypted state bytes');
  const f = fake((c) => {
    if (isMeta(c)) {
      assert.equal(c.endpoint, `https://www.googleapis.com/drive/v2/files/${fileId}?fields=id,title,etag,fileSize,md5Checksum,mimeType,parents,headRevisionId,labels(trashed)`);
      return env({ status: 200, data: meta(bytes), headers: {} });
    }
    if (isMedia(c)) {
      assert.equal(c.endpoint, `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      return env({ status: 200, data: null, binary_data: { url: STORAGE, content_type: 'application/octet-stream', size: bytes.length } });
    }
    assert.equal(c.url, STORAGE); assert.equal(c.init.headers, undefined); assert.equal(c.init.redirect, 'error'); assert.ok(c.init.signal);
    return new Response(bytes);
  });
  const result = await createFileTransport({ ...options, fetchImpl: f.impl }).read();
  assert.deepEqual(result, { bytes, etag: ETAG, revisionId: 'synthetic_rev_head' });
  assert.deepEqual(f.calls.map((c) => c.kind), ['proxy', 'proxy', 'storage', 'proxy']);
});

test('read accepts inline data only when its exact serialization matches MD5', async () => {
  const bytes = Buffer.from('{"synthetic":true}');
  let inline = 'synthetic inline';
  const make = () => fake((c) => isMeta(c) ? env({ status: 200, data: meta(Buffer.from(typeof inline === 'string' ? inline : JSON.stringify(inline))) })
    : env({ status: 200, data: inline }));
  assert.deepEqual((await createFileTransport({ ...options, fetchImpl: make().impl }).read()).bytes, Buffer.from(inline));
  inline = JSON.parse(bytes.toString());
  assert.deepEqual((await createFileTransport({ ...options, fetchImpl: make().impl }).read()).bytes, bytes);
  const bad = fake((c) => isMeta(c) ? env({ status: 200, data: meta(Buffer.from('expected bytes!')) }) : env({ status: 200, data: 'tampered bytes!' }));
  await assert.rejects(createFileTransport({ ...options, fetchImpl: bad.impl }).read(), (e) => e.code === 'ERR_DRIVE_FILE_INTEGRITY' && safe(e));
});

test('unchanged file reads still verify binding but skip the encrypted body transfer', async () => {
  const f = fake(c => isMeta(c) ? env({ status: 200, data: meta(Buffer.from('unchanged')) }) : assert.fail('no download'));
  assert.deepEqual(await createFileTransport({ ...options, fetchImpl: f.impl }).read({ etag: ETAG }),
    { unchanged: true, etag: ETAG, revisionId: 'synthetic_rev_head' });
  assert.equal(f.calls.length, 1);
  const wrong = fake(c => env({ status: 200, data: meta(Buffer.from('unchanged'), { parents: [{ id: 'foreign_folder_123' }] }) }));
  await assert.rejects(createFileTransport({ ...options, fetchImpl: wrong.impl }).read({ etag: ETAG }), { code: 'ERR_DRIVE_FILE_BINDING' });
});

test('read rejects disallowed hosts, http, userinfo and oversized or mismatched downloads', async () => {
  const bytes = Buffer.from('synthetic bytes');
  for (const url of ['https://evil.invalid/object', 'http://synthetic-bucket.s3.amazonaws.com/o', 'https://user:pw@synthetic-bucket.s3.amazonaws.com/o',
    'https://amazonaws.com.evil.invalid/o', 'https://synthetic-bucket.s3.amazonaws.com:8443/o', 'not a url']) {
    const f = fake((c) => isMeta(c) ? env({ status: 200, data: meta(bytes) }) : isMedia(c) ? env({ status: 200, binary_data: { url } }) : assert.fail('egress'));
    await assert.rejects(createFileTransport({ ...options, fetchImpl: f.impl }).read(), (e) => e.code === 'ERR_DRIVE_FILE_PROVIDER' && safe(e));
    assert.equal(f.calls.filter((c) => c.kind === 'storage').length, 0);
  }
  for (const body of [Buffer.concat([bytes, Buffer.from('extra')]), Buffer.from('different bytes'), bytes.subarray(1)]) {
    const f = fake((c) => isMeta(c) ? env({ status: 200, data: meta(bytes) }) : isMedia(c) ? env({ status: 200, binary_data: { url: STORAGE } }) : new Response(body));
    await assert.rejects(createFileTransport({ ...options, fetchImpl: f.impl }).read(), (e) => e.code === 'ERR_DRIVE_FILE_INTEGRITY' && safe(e));
  }
  const big = fake(() => env({ status: 200, data: { ...meta(bytes), fileSize: String(MAX_FILE_BYTES + 1) } }));
  await assert.rejects(createFileTransport({ ...options, fetchImpl: big.impl }).read(), { code: 'ERR_DRIVE_FILE_INTEGRITY' });
  assert.equal(big.calls.length, 1);
});

test('read returns null bytes only for an empty initial file', async () => {
  const f = fake((c) => isMeta(c) ? env({ status: 200, data: meta(null, { headRevisionId: undefined }) }) : assert.fail('no download for empty file'));
  assert.deepEqual(await createFileTransport({ ...options, fetchImpl: f.impl }).read(), { bytes: null, etag: ETAG, revisionId: null });
  const g = fake(() => env({ status: 200, data: { ...meta(null), md5Checksum: md5(Buffer.from('x')) } }));
  await assert.rejects(createFileTransport({ ...options, fetchImpl: g.impl }).read(), { code: 'ERR_DRIVE_FILE_INTEGRITY' });
  const h = fake(() => env({ status: 200, data: { ...meta(Buffer.from('abc')), md5Checksum: undefined } }));
  await assert.rejects(createFileTransport({ ...options, fetchImpl: h.impl }).read(), { code: 'ERR_DRIVE_FILE_INTEGRITY' });
});

test('read rejects binding mismatches before downloading', async () => {
  const bytes = Buffer.from('synthetic');
  for (const change of [{ title: 'other.bin' }, { parents: [{ id: 'foreign_folder_123' }] }, { parents: [folderId] },
    { mimeType: 'application/vnd.google-apps.document' }, { mimeType: 'application/vnd.google-apps.folder' }, { id: 'other_file_12345' }, { labels: { trashed: true } }]) {
    const f = fake((c) => isMeta(c) ? env({ status: 200, data: meta(bytes, change) }) : assert.fail('no download expected'));
    await assert.rejects(createFileTransport({ ...options, fetchImpl: f.impl }).read(), (e) => e.code === 'ERR_DRIVE_FILE_BINDING' && safe(e));
    assert.equal(f.calls.length, 1);
  }
  const missing = fake(() => env({ status: 404, data: 'private-provider-body' }));
  await assert.rejects(createFileTransport({ ...options, fetchImpl: missing.impl }).read(), (e) => e.code === 'ERR_DRIVE_FILE_BINDING' && safe(e));
  const noEtag = fake(() => env({ status: 200, data: meta(bytes, { etag: undefined }) }));
  await assert.rejects(createFileTransport({ ...options, fetchImpl: noEtag.impl }).read(), { code: 'ERR_DRIVE_FILE_PROVIDER' });
});

test('read reports ambiguity when the file changes during download', async () => {
  const bytes = Buffer.from('synthetic'); let metas = 0;
  const f = fake((c) => isMeta(c) ? env({ status: 200, data: meta(bytes, ++metas > 1 ? { etag: ETAG2 } : {}) }) : env({ status: 200, data: 'synthetic' }));
  await assert.rejects(createFileTransport({ ...options, fetchImpl: f.impl }).read(), (e) => e.code === 'ERR_DRIVE_FILE_AMBIGUOUS' && e.uncertain);
});

/** Upload scenario harness: route(c, chunkIndex) may override chunk responses. */
function uploader(bytes, { init, chunk, finalMeta, location = LOCATION, metaBefore } = {}) {
  let chunks = 0, metas = 0;
  const chunkCount = Math.ceil(bytes.length / CHUNK_SIZE);
  const f = fake((c) => {
    if (isMeta(c)) {
      metas++;
      if (metas === 1) return env({ status: 200, data: metaBefore ?? meta(Buffer.from('old'), {}) });
      return env({ status: 200, data: finalMeta ?? meta(bytes, { etag: ETAG2, headRevisionId: 'synthetic_rev_new' }) });
    }
    if (isInit(c)) return init ? init(c) : env({ status: 200, data: '', headers: { Location: location } });
    if (isChunk(c)) {
      const i = chunks++;
      if (chunk) { const r = chunk(c, i, chunkCount); if (r) return r; }
      if (i < chunkCount - 1) return env({ status: 308, data: '', headers: { range: `bytes=0-${Math.min((i + 1) * CHUNK_SIZE, bytes.length) - 1}` } });
      return env({ status: 200, data: { id: fileId, md5Checksum: md5(bytes), fileSize: String(bytes.length), headRevisionId: 'synthetic_rev_new', etag: ETAG2 } });
    }
    assert.fail('unexpected request');
  });
  return f;
}
const payload = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff; return b; };

test('write uploads 2.5 MiB as three conditional chunks with exact ranges and base64 content', async () => {
  const bytes = payload(Math.floor(2.5 * CHUNK_SIZE)), total = bytes.length;
  const f = uploader(bytes);
  assert.deepEqual(await createFileTransport({ ...options, fetchImpl: f.impl }).write(bytes, { etag: ETAG }), { etag: ETAG2, revisionId: 'synthetic_rev_new' });
  const init = f.calls.find(isInit);
  assert.equal(init.method, 'PUT');
  assert.equal(init.endpoint, `https://www.googleapis.com/upload/drive/v2/files/${fileId}?uploadType=resumable`);
  assert.deepEqual(init.body.body, { mimeType: 'application/octet-stream' });
  assert.deepEqual(init.params['If-Match'], { name: 'If-Match', type: 'header', value: ETAG });
  assert.equal(init.params['X-Upload-Content-Type'].value, 'application/octet-stream');
  assert.equal(init.params['X-Upload-Content-Length'].value, String(total));
  const chunks = f.calls.filter(isChunk);
  assert.equal(chunks.length, 3);
  const expected = [[0, CHUNK_SIZE - 1], [CHUNK_SIZE, 2 * CHUNK_SIZE - 1], [2 * CHUNK_SIZE, total - 1]];
  chunks.forEach((c, i) => {
    const [s, e] = expected[i];
    assert.equal(c.endpoint, LOCATION); assert.equal(c.method, 'PUT');
    assert.equal(c.params['Content-Range'].value, `bytes ${s}-${e}/${total}`);
    assert.equal(c.params['Content-Range'].type, 'header');
    assert.equal(c.params['If-Match'].value, ETAG);
    assert.equal(c.body.binary_body.content_type, 'application/octet-stream');
    const decoded = Buffer.from(c.body.binary_body.base64, 'base64');
    assert.equal(decoded.length, i < 2 ? CHUNK_SIZE : total - 2 * CHUNK_SIZE);
    assert.deepEqual(decoded, bytes.subarray(s, e + 1));
  });
  assert.equal(f.calls.filter(isMeta).length, 2);
});

test('write refuses a stale ETag, oversize and zero-length payloads without mutating', async () => {
  const f = uploader(Buffer.from('new'), { metaBefore: meta(Buffer.from('old'), { etag: ETAG2 }) });
  const t = createFileTransport({ ...options, fetchImpl: f.impl });
  await assert.rejects(t.write(Buffer.from('new'), { etag: ETAG }), (e) => e.code === 'ERR_DRIVE_FILE_CONFLICT' && e.status === 412);
  assert.equal(f.calls.filter((c) => isInit(c) || isChunk(c)).length, 0);
  const none = fake(() => assert.fail('no request expected'));
  const n = createFileTransport({ ...options, fetchImpl: none.impl });
  await assert.rejects(n.write(Buffer.alloc(MAX_FILE_BYTES + 1), { etag: ETAG }), (e) => e.code === 'ERR_DRIVE_FILE_CONFIG' && /90 MiB/.test(e.message));
  await assert.rejects(n.write(Buffer.alloc(0), { etag: ETAG }), (e) => e.code === 'ERR_DRIVE_FILE_CONFIG' && /Zero-length/.test(e.message));
  await assert.rejects(n.write(Buffer.from('x'), {}), { code: 'ERR_DRIVE_FILE_CONFIG' });
  await assert.rejects(n.write('string', { etag: ETAG }), { code: 'ERR_DRIVE_FILE_CONFIG' });
  assert.equal(none.calls.length, 0);
});

test('write rechecks binding before mutating', async () => {
  const f = uploader(Buffer.from('new'), { metaBefore: meta(Buffer.from('old'), { parents: [{ id: 'foreign_folder_123' }] }) });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: f.impl }).write(Buffer.from('new'), { etag: ETAG }), { code: 'ERR_DRIVE_FILE_BINDING' });
  assert.equal(f.calls.length, 1);
});

test('412 on init or mid-chunk is a typed conflict and stops immediately', async () => {
  const bytes = payload(3 * CHUNK_SIZE);
  const a = uploader(bytes, { init: () => env({ status: 412, data: 'private-provider-body' }) });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: a.impl }).write(bytes, { etag: ETAG }), (e) => e.code === 'ERR_DRIVE_FILE_CONFLICT' && safe(e));
  assert.equal(a.calls.filter(isChunk).length, 0);
  const b = uploader(bytes, { chunk: (c, i) => i === 1 ? env({ status: 412, data: 'private-provider-body' }) : undefined });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: b.impl }).write(bytes, { etag: ETAG }), (e) => e.code === 'ERR_DRIVE_FILE_CONFLICT' && e.uncertain === false && safe(e));
  assert.equal(b.calls.filter(isChunk).length, 2);
});

test('unexpected statuses, premature success and timeouts are uncertain and never replayed', async () => {
  const bytes = payload(3 * CHUNK_SIZE);
  const cases = [
    { chunk: (c, i) => i === 1 ? env({ status: 503, data: 'private-provider-body' }) : undefined, chunks: 2 },
    { chunk: (c, i) => i === 0 ? env({ status: 200, data: { md5Checksum: md5(bytes) } }) : undefined, chunks: 1 },
    { chunk: (c, i) => i === 0 ? env({ status: 201, data: {} }) : undefined, chunks: 1 },
    { chunk: (c, i) => i === 2 ? env({ status: 308, data: '' }) : undefined, chunks: 3 },
    { chunk: (c, i) => i === 1 ? env({ status: 308, headers: { Range: 'bytes=0-100' } }) : undefined, chunks: 2 },
    { chunk: (c, i) => i === 1 ? Response.json({ error: 'private-provider-body' }, { status: 502 }) : undefined, chunks: 2 },
    { chunk: (c, i) => i === 1 ? Promise.reject(Object.assign(new Error('private-provider-body'), { name: 'TypeError' })) : undefined, chunks: 2 },
    { init: () => env({ status: 500, data: 'private-provider-body' }), chunks: 0 },
  ];
  for (const scenario of cases) {
    const f = uploader(bytes, scenario);
    await assert.rejects(createFileTransport({ ...options, fetchImpl: f.impl }).write(bytes, { etag: ETAG }),
      (e) => e.code === 'ERR_DRIVE_FILE_UNCERTAIN' && e.uncertain === true && safe(e));
    assert.equal(f.calls.filter(isChunk).length, scenario.chunks);
    assert.equal(f.calls.filter(isInit).length, 1);
    assert.equal(f.calls.filter(isMeta).length, 1, 'no post-failure probing or replay');
  }
  // Real timeout through AbortSignal.timeout with a short injected deadline.
  const hang = uploader(bytes, { chunk: (c, i, n) => i === 1 ? new Promise((_, reject) => {
    const signal = hang.lastSignal; signal.addEventListener('abort', () => reject(signal.reason));
  }) : undefined });
  const inner = hang.impl;
  hang.impl = (url, init) => { hang.lastSignal = init.signal; return inner(url, init); };
  await assert.rejects(createFileTransport({ ...options, timeoutMs: 50, fetchImpl: hang.impl }).write(bytes, { etag: ETAG }),
    (e) => e.code === 'ERR_DRIVE_FILE_UNCERTAIN' && /timeout/.test(e.message) && safe(e));
  assert.equal(hang.calls.filter(isChunk).length, 2);
});

test('the resumable Location must be the exact HTTPS Drive upload path', async () => {
  const bytes = Buffer.from('synthetic');
  for (const location of ['https://evil.invalid/upload/drive/v2/files/' + fileId, 'http://www.googleapis.com/upload/drive/v2/files/' + fileId,
    `https://www.googleapis.com/upload/drive/v2/files/other_file_12345?upload_id=x`, `https://www.googleapis.com/upload/drive/v3/files/${fileId}`,
    `https://user:pw@www.googleapis.com/upload/drive/v2/files/${fileId}`, `https://www.googleapis.com/upload/drive/v2/files/${fileId}?upload_id=x#frag`,
    `https://www.googleapis.com:8443/upload/drive/v2/files/${fileId}`, `https://www.googleapis.com/upload/drive/v2/files/${fileId}`,
    `https://www.googleapis.com/upload/drive/v2/files/${fileId}?upload_id=a&upload_id=b`, 'garbage']) {
    const f = uploader(bytes, { location });
    await assert.rejects(createFileTransport({ ...options, fetchImpl: f.impl }).write(bytes, { etag: ETAG }), (e) => e.code === 'ERR_DRIVE_FILE_PROVIDER' && safe(e));
    assert.equal(f.calls.filter(isChunk).length, 0);
  }
  const missing = uploader(bytes, { init: () => env({ status: 200, headers: {} }) });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: missing.impl }).write(bytes, { etag: ETAG }), { code: 'ERR_DRIVE_FILE_PROVIDER' });
  const lower = uploader(bytes, { init: () => env({ status: 200, headers: { location: LOCATION } }) });
  await createFileTransport({ ...options, fetchImpl: lower.impl }).write(bytes, { etag: ETAG });
});

test('final integrity mismatch and immediate foreign changes are not reported as success', async () => {
  const bytes = payload(CHUNK_SIZE + 10);
  const wrong = uploader(bytes, { chunk: (c, i) => i === 1 ? env({ status: 200, data: { md5Checksum: md5(Buffer.from('other')), fileSize: String(bytes.length) } }) : undefined });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: wrong.impl }).write(bytes, { etag: ETAG }), (e) => e.code === 'ERR_DRIVE_FILE_INTEGRITY' && e.uncertain);
  const shortSize = uploader(bytes, { chunk: (c, i) => i === 1 ? env({ status: 200, data: { md5Checksum: md5(bytes), fileSize: '1' } }) : undefined });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: shortSize.impl }).write(bytes, { etag: ETAG }), { code: 'ERR_DRIVE_FILE_INTEGRITY' });
  const foreign = uploader(bytes, { finalMeta: meta(Buffer.from('another writer'), { etag: '"synthetic-etag-3"', headRevisionId: 'synthetic_rev_other' }) });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: foreign.impl }).write(bytes, { etag: ETAG }), (e) => e.code === 'ERR_DRIVE_FILE_AMBIGUOUS' && e.uncertain);
  const sameBytesNewRev = uploader(bytes, { finalMeta: meta(bytes, { etag: '"synthetic-etag-3"', headRevisionId: 'synthetic_rev_other' }) });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: sameBytesNewRev.impl }).write(bytes, { etag: ETAG }), { code: 'ERR_DRIVE_FILE_AMBIGUOUS' });
  for (const f of [wrong, foreign]) assert.equal(f.calls.filter(isChunk).length, 2);
});

/** Revision harness. */
function revisions({ head = 'synthetic_rev_head', deleteStatus = () => 204, metaFor } = {}) {
  let metas = 0;
  return fake((c) => {
    if (isMeta(c)) { metas++; return env({ status: 200, data: metaFor ? metaFor(metas) : meta(Buffer.from('x'), { headRevisionId: head }) }); }
    if (isDelete(c)) {
      const rev = c.endpoint.split('/revisions/')[1];
      assert.equal(c.endpoint, `https://www.googleapis.com/drive/v3/files/${fileId}/revisions/${rev}`);
      return env({ status: deleteStatus(rev), data: '' });
    }
    assert.fail('unexpected request');
  });
}

test('purgeRevisions deletes exact deduplicated ids and treats 404 as already absent', async () => {
  const f = revisions({ deleteStatus: (rev) => rev === 'synthetic_rev_gone' ? 404 : 204 });
  const result = await createFileTransport({ ...options, fetchImpl: f.impl }).purgeRevisions(['synthetic_rev_a', 'synthetic_rev_gone', 'synthetic_rev_a']);
  assert.deepEqual(result, [{ id: 'synthetic_rev_a', result: 'deleted' }, { id: 'synthetic_rev_gone', result: 'absent' }]);
  assert.equal(f.calls.filter(isDelete).length, 2);
});

test('purgeRevisions forbids the head, invalid ids and binding failures before any DELETE', async () => {
  const head = revisions();
  await assert.rejects(createFileTransport({ ...options, fetchImpl: head.impl }).purgeRevisions(['synthetic_rev_a', 'synthetic_rev_head']), { code: 'ERR_DRIVE_FILE_CONFIG' });
  assert.equal(head.calls.filter(isDelete).length, 0);
  const none = fake(() => assert.fail('no request expected'));
  const t = createFileTransport({ ...options, fetchImpl: none.impl });
  for (const ids of [[], ['bad id'], [''], [42], 'synthetic_rev_a', ['../x'], Array.from({ length: 201 }, (_, i) => `rev_${i}`)])
    await assert.rejects(t.purgeRevisions(ids), { code: 'ERR_DRIVE_FILE_CONFIG' });
  assert.equal(none.calls.length, 0);
  for (const change of [{ title: 'other.bin' }, { parents: [{ id: 'foreign_folder_123' }] }, { mimeType: 'application/vnd.google-apps.spreadsheet' }]) {
    const f = revisions({ metaFor: () => meta(Buffer.from('x'), change) });
    await assert.rejects(createFileTransport({ ...options, fetchImpl: f.impl }).purgeRevisions(['synthetic_rev_a']), { code: 'ERR_DRIVE_FILE_BINDING' });
    assert.equal(f.calls.filter(isDelete).length, 0);
  }
  // Binding changes between deletions stop further mutation.
  const moved = revisions({ metaFor: (n) => meta(Buffer.from('x'), n >= 3 ? { parents: [{ id: 'foreign_folder_123' }] } : {}) });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: moved.impl }).purgeRevisions(['synthetic_rev_a', 'synthetic_rev_b']),
    (e) => e.code === 'ERR_DRIVE_FILE_BINDING' && e.results[0].result === 'deleted' && e.results[1].result === 'skipped');
  assert.equal(moved.calls.filter(isDelete).length, 1);
});

test('purgeRevisions stops on refusal or uncertainty without replaying deletes', async () => {
  const refused = revisions({ deleteStatus: (rev) => rev === 'synthetic_rev_b' ? 403 : 204 });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: refused.impl }).purgeRevisions(['synthetic_rev_a', 'synthetic_rev_b', 'synthetic_rev_c']),
    (e) => e.code === 'ERR_DRIVE_FILE_PROVIDER' && e.status === 403 && e.results.map((r) => r.result).join() === 'deleted,failed,skipped' && safe(e));
  assert.equal(refused.calls.filter(isDelete).length, 2);
  const unsure = revisions({ deleteStatus: () => 503 });
  await assert.rejects(createFileTransport({ ...options, fetchImpl: unsure.impl }).purgeRevisions(['synthetic_rev_a', 'synthetic_rev_b']),
    (e) => e.code === 'ERR_DRIVE_FILE_UNCERTAIN' && e.results[0].result === 'uncertain');
  assert.equal(unsure.calls.filter(isDelete).length, 1);
});

test('listRevisions paginates with bounded pages and rejects repeated tokens', async () => {
  const pages = { '': { revisions: [{ id: 'synthetic_rev_1', keepForever: false }], nextPageToken: 'tok+/=1' },
    'tok+/=1': { revisions: [{ id: 'synthetic_rev_2', md5Checksum: 'x' }], nextPageToken: 'tok2' },
    tok2: { revisions: [{ id: 'synthetic_rev_head' }] } };
  const seen = [];
  const f = fake((c) => {
    if (isMeta(c)) return env({ status: 200, data: meta(Buffer.from('x')) });
    const url = new URL(c.endpoint);
    assert.equal(url.pathname, `/drive/v3/files/${fileId}/revisions`);
    assert.equal(url.searchParams.get('fields'), 'nextPageToken,revisions(id,modifiedTime,size,md5Checksum,keepForever)');
    const token = url.searchParams.get('pageToken') ?? ''; seen.push(token);
    return env({ status: 200, data: pages[token] });
  });
  const t = createFileTransport({ ...options, fetchImpl: f.impl });
  const first = await t.listRevisions({ pageSize: 1, maxPages: 2 });
  assert.deepEqual(first.revisions.map((r) => r.id), ['synthetic_rev_1', 'synthetic_rev_2']);
  assert.equal(first.nextPageToken, 'tok2');
  const rest = await t.listRevisions({ pageToken: first.nextPageToken });
  assert.deepEqual(rest, { revisions: [{ id: 'synthetic_rev_head', modifiedTime: undefined, size: undefined, md5Checksum: undefined, keepForever: false }] });
  assert.deepEqual(seen, ['', 'tok+/=1', 'tok2']);
  await assert.rejects(t.listRevisions({ maxPages: 51 }), { code: 'ERR_DRIVE_FILE_CONFIG' });
  await assert.rejects(t.listRevisions({ pageSize: 0 }), { code: 'ERR_DRIVE_FILE_CONFIG' });
  const loop = fake((c) => isMeta(c) ? env({ status: 200, data: meta(Buffer.from('x')) }) : env({ status: 200, data: { revisions: [], nextPageToken: 'same' } }));
  await assert.rejects(createFileTransport({ ...options, fetchImpl: loop.impl }).listRevisions(), { code: 'ERR_DRIVE_FILE_PROVIDER' });
  assert.equal(loop.calls.length, 3);
});
