import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CloudJournal } from '../src/cloud-journal.mjs';
import { prepareCloudArchive, restoreCloudArchive, checkpointId } from '../src/cloud-archive.mjs';
import { exportBrain, saveBrainRecord, importBrainFile, readBrainAsset } from '../src/brain.mjs';
import { rememberHiveFact, forgetHiveFact, readHiveMind } from '../src/core/store.ts';
import { ownStateDirectory } from '../src/ownership.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-cloud-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  const file = path.join(source, 'hive-mind.json');
  const journal = new CloudJournal({ transport: {}, key: randomBytes(32), workspace: 'synthetic', client: 'test' });
  return { root, source, file, journal, pending: path.join(root, 'pending.checkpoint') };
}

test('encrypted archive round-trip retains actual file bytes, histories, tombstones, IDs and retry receipts', async t => {
  const f = await fixture(t);
  const forgotten = await rememberHiveFact(f.file, { scope: 'general', subject: 'forget this', fact: 'synthetic', sourceThreadId: 'test' });
  await forgetHiveFact(f.file, forgotten.id);
  const memory = await rememberHiveFact(f.file, { scope: 'general', subject: 'keep this', fact: 'synthetic kept', sourceThreadId: 'test' });
  const input = { kind: 'entity', scope: 'general', title: 'fixture', source: { threadId: 'test', provider: 'test', type: 'user' },
    data: { entityType: 'fixture', description: 'before' }, eventId: 'synthetic-create' };
  const record = await saveBrainRecord(f.file, input);
  // Public helper returns {record,...}; use canonical record to bind the edit.
  const saved = (await readHiveMind(f.file)).continuity.records.find(r => r.kind === 'entity');
  await saveBrainRecord(f.file, { ...input, id: saved.id, revision: saved.revision, eventId: 'synthetic-edit',
    data: { entityType: 'fixture', description: 'after' } });
  await importBrainFile(f.file, { scope: 'general', title: 'synthetic retained bytes', filename: 'fixture.txt',
    source: input.source, base64: Buffer.from('test file bytes').toString('base64') });
  const before = await exportBrain(f.file);
  const manifest = await prepareCloudArchive(f.source, f.journal, f.pending);
  assert.equal(manifest.memories, 1); assert.equal(manifest.records, 2); assert.equal(manifest.assets, 1);
  const bytes = await fs.readFile(f.pending);
  assert.equal(bytes.includes('test file bytes'), false);
  assert.equal(checkpointId(bytes), manifest.id);
  const destination = path.join(f.root, 'auro');
  await restoreCloudArchive(destination, f.journal, manifest.id, bytes);
  const after = await exportBrain(path.join(destination, 'hive-mind.json'));
  assert.deepEqual(after.store.memories, before.store.memories);
  assert.equal(after.store.memories[0].id, memory.id);
  assert.deepEqual(after.store.forgotten, before.store.forgotten);
  assert.deepEqual(after.store.continuity.records, before.store.continuity.records);
  assert.deepEqual(after.store.continuity.receipts, before.store.continuity.receipts);
  assert.deepEqual(after.images, before.images);
  const asset = after.store.continuity.records.find(r => r.kind === 'asset');
  assert.equal((await readBrainAsset(path.join(destination, 'hive-mind.json'), asset.id)).bytes.toString(), 'test file bytes');
  assert.equal(record !== null, true);
});

test('live owner, existing pending ciphertext and nonempty restore target reject without replacing state', async t => {
  const f = await fixture(t);
  await rememberHiveFact(f.file, { scope: 'general', subject: 'fixture', fact: 'unchanged', sourceThreadId: 'test' });
  const original = await fs.readFile(f.file);
  const release = await ownStateDirectory(f.source);
  await assert.rejects(prepareCloudArchive(f.source, f.journal, f.pending), /running Hive Mind owner/);
  await release();
  const manifest = await prepareCloudArchive(f.source, f.journal, f.pending);
  const ciphertext = await fs.readFile(f.pending);
  await assert.rejects(prepareCloudArchive(f.source, f.journal, f.pending), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(f.pending), ciphertext);
  await assert.rejects(restoreCloudArchive(f.source, f.journal, manifest.id, ciphertext), /empty dedicated/);
  assert.deepEqual(await fs.readFile(f.file), original);
});

test('authenticated but malformed/future archive rejects before changing target metadata', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'auro');
  const bad = f.journal.encode({ format: 'hive-mind.archive.v1', store: { version: 2, memories: [] }, images: {} });
  await assert.rejects(restoreCloudArchive(target, f.journal, bad.id, bad.bytes), /malformed/);
  await assert.rejects(fs.access(path.join(target, 'hive-mind.json')), { code: 'ENOENT' });
});
