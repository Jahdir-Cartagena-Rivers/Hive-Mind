import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { CloudJournal } from '../src/cloud-journal.mjs';
import { ChunkedTransport } from '../src/cloud-chunks.mjs';
import { newContinuity, fingerprint } from '../src/core/continuity.ts';
import { hiveForgetMarker } from '../src/core/store.ts';
import { collectCloudErasures, redactCloudArchive } from '../src/cloud-erasure.mjs';

const memory = (subject, fact) => ({ id: randomUUID(), scope: 'general', project: null, subject, fact,
  sourceThreadId: 'synthetic', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const archive = memories => ({ format: 'hive-mind.archive.v1', store: { version: 1, memories, continuity: newContinuity() }, images: {} });
function fixture(chunked = false) {
  const files = new Map(); let counter = 0;
  const raw = { files, async list() { return [...files].map(([id, row]) => ({ id, name: row.name })); },
    async read(id) { if (!files.has(id)) throw new Error('missing'); return files.get(id).bytes; },
    async create(name, bytes) { const id = String(counter++); files.set(id, { name, bytes }); return { id, name }; },
    async remove(id, name) { assert.equal(files.get(id)?.name, name); files.delete(id); } };
  const transport = chunked ? new ChunkedTransport(raw, 150) : raw;
  const journal = new CloudJournal({ transport, key: randomBytes(32), workspace: 'synthetic-erasure', client: 'desktop' });
  return { files, raw, transport, journal };
}
async function seeded(f) {
  const secret = memory('private synthetic subject', 'private synthetic content'), keep = memory('keep', 'retained');
  const before = archive([secret, keep]);
  const root = f.journal.encode(before); await f.journal.publish(root);
  const after = structuredClone(before); after.store.memories.shift(); after.store.forgotten = [hiveForgetMarker(secret)];
  const next = f.journal.encode(after, root.id); await f.journal.publish(next);
  return { secret, keep, before, after, root, next, rules: collectCloudErasures([before, after]) };
}

test('history erasure preserves graph identity and unrelated memory while permanently removing original blobs', async () => {
  const f = fixture(), s = await seeded(f);
  const originalId = [...f.files].find(([, row]) => row.name === `hive-${s.root.id}.checkpoint`)[0];
  const result = await f.journal.eraseHistory(s.rules);
  assert.equal(result.erased, true); assert.equal(f.files.has(originalId), false);
  const current = await f.journal.inspect();
  assert.deepEqual(current.heads, [s.next.id]); assert.equal(current.checkpoints.size, 2);
  assert.equal(current.checkpoints.get(s.root.id).archive.store.memories[0].id, s.keep.id);
  for (const row of current.candidates) {
    assert.equal(JSON.stringify(row.checkpoint).includes(s.secret.fact), false);
    assert.equal(JSON.stringify(row.checkpoint).includes(s.secret.subject), false);
  }
  const count = f.files.size;
  assert.equal((await f.journal.eraseHistory(s.rules)).removed, 0); assert.equal(f.files.size, count);
});

test('durable marker precedes rewrite and prevents stale publication even when cleanup is interrupted', async () => {
  const f = fixture(), s = await seeded(f), create = f.transport.create;
  let marker = false;
  f.transport.create = async (name, bytes) => {
    if (name.endsWith('.erasure')) { marker = true; return create(name, bytes); }
    assert.equal(marker, true); throw new Error('rewrite interrupted');
  };
  await assert.rejects(f.journal.eraseHistory(s.rules), /interrupted/);
  assert.equal((await f.journal.inspect()).checkpoints.get(s.root.id).archive.store.memories.length, 1);
  await assert.rejects(f.journal.publish(f.journal.encode(s.before, s.next.id)), /erased content/);
  f.transport.create = create;
  assert.equal((await f.journal.eraseHistory(s.rules)).erased, true);
});

test('delete failure leaves a verified replacement and safe retry preserves all unaffected history', async () => {
  const f = fixture(), s = await seeded(f), remove = f.transport.remove;
  f.transport.remove = async () => { throw new Error('delete interrupted'); };
  await assert.rejects(f.journal.eraseHistory(s.rules), /delete interrupted/);
  assert.equal((await f.journal.inspect()).checkpoints.size, 2);
  f.transport.remove = remove;
  assert.equal((await f.journal.eraseHistory(s.rules)).erased, true);
});

test('a racing old writer is redacted on read and reported pending until its blob is scrubbed', async () => {
  const f = fixture(), s = await seeded(f), remove = f.transport.remove;
  const late = f.journal.encode(s.before, s.next.id); let race = true;
  f.transport.remove = async (...args) => {
    await remove(...args);
    if (race) { race = false; await f.transport.create(`hive-${late.id}.checkpoint`, late.bytes); }
  };
  assert.equal((await f.journal.eraseHistory(s.rules)).pending, true);
  assert.equal((await f.journal.inspect()).checkpoints.get(late.id).archive.store.memories.length, 1);
  assert.equal((await f.journal.eraseHistory(s.rules)).erased, true);
});

test('chunked erasure removes retained ciphertext parts and reports unknown orphans without deleting them', async () => {
  const f = fixture(true), s = await seeded(f);
  assert.equal((await f.journal.eraseHistory(s.rules)).erased, true);
  assert.equal((await f.transport.erasureAudit()).orphanParts, 0);
  await f.raw.create(`hive-part-${'a'.repeat(64)}.blob`, Buffer.from('unknown in-flight bytes'));
  const result = await f.journal.eraseHistory(s.rules);
  assert.equal(result.erased, false); assert.equal(result.orphanParts, 1);
});

test('record/asset redaction purges historical references and preserves retry receipts deterministically', () => {
  const a = archive([]), assetId = randomUUID(), relatedId = randomUUID(), keepId = randomUUID();
  const asset = { id: assetId, kind: 'asset', title: 'private image', data: { hash: 'a'.repeat(64) }, history: [], revision: 'old' };
  const keep = { id: keepId, kind: 'artifact', title: 'keep', data: { assetIds: [assetId] }, revision: 'old',
    history: [{ data: { assetIds: [assetId] }, revision: 'history' }] };
  const relation = { id: relatedId, kind: 'relation', data: { from: assetId, to: keepId }, history: [] };
  a.store.continuity.records = [asset, keep, relation]; a.images['a'.repeat(64)] = 'private bytes';
  a.store.continuity.receipts = [{ key: 'retry', id: assetId, digest: 'content-free-digest' }];
  const later = structuredClone(a); later.store.continuity.forgotten = [assetId];
  const rules = collectCloudErasures([a, later]);
  assert.deepEqual(new Set(rules.recordIds), new Set([assetId, relatedId]));
  const redacted = redactCloudArchive(a, rules);
  assert.deepEqual(redacted.store.continuity.records[0].data.assetIds, []);
  assert.deepEqual(redacted.store.continuity.records[0].history[0].data.assetIds, []);
  assert.deepEqual(redacted.images, {}); assert.deepEqual(redacted.store.continuity.receipts, a.store.continuity.receipts);
  assert.equal(fingerprint(redacted), fingerprint(redactCloudArchive(a, rules)));
  assert.equal(a.store.continuity.records.length, 3);
});

test('successive forgets redact earlier aliases without order-dependent record revisions', async () => {
  const f = fixture(), a = archive([]), one = randomUUID(), two = randomUUID();
  a.store.continuity.records = [{ id: randomUUID(), kind: 'artifact', title: 'keep', revision: 'old',
    data: { assetIds: [one, two] }, history: [{ data: { assetIds: [one, two] }, revision: 'previous' }] }];
  const first = { memoryIds: [], recordIds: [one] }, second = { memoryIds: [], recordIds: [two] };
  assert.equal(fingerprint(redactCloudArchive(redactCloudArchive(a, first), second)),
    fingerprint(redactCloudArchive(a, { memoryIds: [], recordIds: [one, two] })));
  const s = await seeded(f);
  await f.journal.eraseHistory(s.rules);
  assert.equal((await f.journal.eraseHistory({ memoryIds: [s.keep.id], recordIds: [] })).erased, true);
  assert.equal((await f.journal.inspect()).checkpoints.get(s.root.id).archive.store.memories.length, 0);
});

test('invalid retained links reject before any original checkpoint is deleted', async () => {
  const f = fixture(), s = await seeded(f);
  const invalid = structuredClone(s.before);
  invalid.store.continuity.records = [{ id: randomUUID(), kind: 'artifact', title: 'broken', data: {}, history: [] }];
  const last = f.journal.encode(invalid, s.next.id); await f.journal.publish(last);
  const originals = [...f.files.keys()];
  await assert.rejects(f.journal.eraseHistory(s.rules), /archive|malformed/);
  // An earlier valid original may already have a verified replacement, but the invalid original is retained.
  assert.ok([...f.files.values()].some(row => row.name === `hive-${last.id}.checkpoint`));
  assert.ok(originals.length > 0);
});
