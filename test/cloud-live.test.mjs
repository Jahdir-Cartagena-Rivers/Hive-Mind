import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
process.env.HIVE_MIND_SEMANTIC = 'off';
import { startHiveMind } from '../src/service.mjs';
import { liveCloudSnapshot } from '../src/cloud-live.mjs';
import { rememberHiveFact } from '../src/core/store.ts';

async function fixture(t, cloudSyncEnabled = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-cloud-live-'));
  const token = randomBytes(32).toString('hex'), readToken = randomBytes(32).toString('hex');
  const service = await startHiveMind({ stateDirectory: directory, token, readToken, port: 0, cloudSyncEnabled });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const api = async (route, body = {}, key = token, headers = {}) => {
    const response = await fetch(service.origin + route, { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { directory, file: path.join(directory, 'hive-mind.json'), api, token, readToken };
}

test('cloud endpoints are opt-in, full-token-only, reject browser origins and preserve state on rejection', async t => {
  const disabled = await fixture(t, false);
  assert.equal((await disabled.api('/v1/cloud/snapshot')).status, 404);
  const f = await fixture(t);
  assert.equal((await f.api('/v1/cloud/snapshot', {}, 'wrong')).status, 401);
  assert.equal((await f.api('/v1/cloud/snapshot', {}, f.readToken)).status, 403);
  assert.equal((await f.api('/v1/cloud/apply', {}, f.readToken)).status, 403);
  assert.equal((await f.api('/v1/cloud/snapshot', {}, f.token, { origin: 'https://example.invalid' })).status, 403);
});

test('validated cloud apply shares mutation queue, preserves local stream and emits fresh sequence', async t => {
  const f = await fixture(t);
  await rememberHiveFact(f.file, { scope: 'general', subject: 'fixture', fact: 'before', sourceThreadId: 'synthetic' });
  const before = (await f.api('/v1/cloud/snapshot')).body;
  const incoming = structuredClone(before.archive); incoming.store.memories[0].fact = 'remote correction';
  assert.equal((await f.api('/v1/cloud/apply', { archive: incoming, expectedRevision: before.revision })).status, 200);
  const after = (await f.api('/v1/cloud/snapshot')).body;
  assert.equal(after.archive.store.memories[0].fact, 'remote correction');
  assert.equal(after.archive.store.continuity.streamId, before.archive.store.continuity.streamId);
  assert.ok(after.archive.store.continuity.sequence > before.archive.store.continuity.sequence);
});

test('a local edit racing the cloud transfer rejects with 409 and keeps the local correction', async t => {
  const f = await fixture(t);
  await rememberHiveFact(f.file, { scope: 'general', subject: 'fixture', fact: 'before', sourceThreadId: 'synthetic' });
  const before = await liveCloudSnapshot(f.file);
  await rememberHiveFact(f.file, { scope: 'general', subject: 'fixture', fact: 'new local correction', sourceThreadId: 'synthetic' });
  const bytes = await fs.readFile(f.file);
  assert.equal((await f.api('/v1/cloud/apply', { archive: before.archive, expectedRevision: before.revision })).status, 409);
  assert.deepEqual(await fs.readFile(f.file), bytes);
  const id = before.archive.store.memories[0].id;
  assert.equal((await f.api('/v1/forget', { id })).status, 200);
  const forgotten = (await f.api('/v1/cloud/snapshot')).body;
  const stale = structuredClone(forgotten.archive); stale.store.forgotten = [];
  assert.equal((await f.api('/v1/cloud/apply', { archive: stale, expectedRevision: forgotten.revision })).status, 409);
});

test('remote asset forget purges unreferenced bytes and blocks a forgotten-ID resurrection', async t => {
  const f = await fixture(t);
  const imported = await f.api('/v1/files', { title: 'synthetic', scope: 'general', filename: 'fixture.txt',
    base64: Buffer.from('synthetic retained bytes').toString('base64'), source: { threadId: 'test', provider: 'test', type: 'user' } });
  assert.equal(imported.status, 200);
  const before = (await f.api('/v1/cloud/snapshot')).body;
  const asset = before.archive.store.continuity.records.find(r => r.kind === 'asset');
  const forgotten = structuredClone(before.archive);
  forgotten.store.continuity.records = [];
  forgotten.store.continuity.forgotten = [asset.id];
  forgotten.images = {};
  assert.equal((await f.api('/v1/cloud/apply', { archive: forgotten, expectedRevision: before.revision })).status, 200);
  await assert.rejects(fs.access(path.join(f.directory, 'visual-assets', asset.data.hash)), { code: 'ENOENT' });
  const current = (await f.api('/v1/cloud/snapshot')).body;
  const resurrected = structuredClone(before.archive);
  resurrected.store.continuity.forgotten = [asset.id];
  assert.equal((await f.api('/v1/cloud/apply', { archive: resurrected, expectedRevision: current.revision })).status, 409);
});

test('unmarked deletion, lost tombstone and invalid archive preserve current canonical bytes', async t => {
  const f = await fixture(t);
  await rememberHiveFact(f.file, { scope: 'general', subject: 'fixture', fact: 'keep', sourceThreadId: 'synthetic' });
  const before = await liveCloudSnapshot(f.file), bytes = await fs.readFile(f.file);
  const deletion = structuredClone(before.archive); deletion.store.memories = [];
  assert.equal((await f.api('/v1/cloud/apply', { archive: deletion, expectedRevision: before.revision })).status, 409);
  const invalid = structuredClone(before.archive); invalid.store.version = 99;
  assert.equal((await f.api('/v1/cloud/apply', { archive: invalid, expectedRevision: before.revision })).status, 400);
  assert.deepEqual(await fs.readFile(f.file), bytes);
});
