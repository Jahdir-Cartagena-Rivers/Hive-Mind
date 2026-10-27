import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
process.env.HIVE_MIND_SEMANTIC = 'off';
import { startHiveMind } from '../src/service.mjs';
import { CloudJournal } from '../src/cloud-journal.mjs';
import { CloudReplica } from '../src/cloud-replica.mjs';
import { liveCloudSnapshot, applyLiveCloudArchive } from '../src/cloud-live.mjs';
import { rememberHiveFact, forgetHiveFact, readHiveMind } from '../src/core/store.ts';
import { importBrainFile } from '../src/brain.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-cloud-replica-'));
  const files = [], key = randomBytes(32), services = [];
  const transport = { async list() { return files.map(f => ({ id: f.id, name: f.name })); },
    async read(id) { return files.find(f => f.id === id).bytes; },
    async create(name, bytes) { files.push({ name, bytes, id: String(files.length) }); } };
  t.after(async () => { for (const service of services) await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const client = async (name, bootstrap) => {
    const directory = path.join(root, name);
    const service = await startHiveMind({ stateDirectory: directory, token: randomBytes(32).toString('hex'), port: 0 });
    services.push(service);
    const file = path.join(directory, 'hive-mind.json');
    const journal = new CloudJournal({ transport, key, workspace: 'synthetic-replicas', client: name });
    const options = { journal, directory: path.join(directory, 'cloud-cache'), bootstrap,
      snapshot: () => liveCloudSnapshot(file), apply: input => applyLiveCloudArchive(file, input) };
    return { file, options, journal, replica: new CloudReplica(options) };
  };
  return { root, files, transport, client };
}
const fact = (subject, value) => ({ scope: 'general', subject, fact: value, sourceThreadId: 'synthetic' });

test('two independent service owners seed, join, exchange edits and become current without repeated uploads', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  await rememberHiveFact(a.file, fact('original', 'one'));
  assert.equal((await a.replica.syncOnce()).status, 'synced');
  assert.equal((await b.replica.syncOnce()).status, 'synced');
  await rememberHiveFact(a.file, fact('desktop addition', 'two'));
  await rememberHiveFact(b.file, fact('auro addition', 'three'));
  assert.equal((await b.replica.syncOnce()).status, 'synced');
  assert.equal((await a.replica.syncOnce()).status, 'synced');
  assert.equal((await b.replica.syncOnce()).status, 'synced');
  const snapshot = await readHiveMind(a.file);
  assert.deepEqual(snapshot.memories, (await readHiveMind(b.file)).memories);
  assert.equal(snapshot.memories.length, 3);
  const count = f.files.length;
  assert.equal((await a.replica.syncOnce()).status, 'current');
  assert.equal(f.files.length, count);
  const cache = await fs.readFile(path.join(a.options.directory, 'replica.checkpoint'));
  assert.equal(cache.includes('desktop addition'), false);
});

test('restart after an uncertain successful upload retries identical ciphertext and preserves pending state', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed');
  await rememberHiveFact(a.file, fact('original', 'one'));
  const create = f.transport.create;
  f.transport.create = async (...args) => { await create(...args); throw new Error('synthetic post-commit interruption'); };
  await assert.rejects(a.replica.syncOnce(), /interruption/);
  assert.equal(f.files.length, 1);
  const restarted = new CloudReplica({ ...a.options, bootstrap: 'resume' });
  assert.equal((await restarted.syncOnce()).status, 'synced');
  assert.equal(f.files.length, 1);
});

test('new local work between upload and apply rejects the stale commit and is merged on retry', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  await rememberHiveFact(a.file, fact('original', 'one'));
  await a.replica.syncOnce(); await b.replica.syncOnce();
  await rememberHiveFact(a.file, fact('remote addition', 'two')); await a.replica.syncOnce();
  let race = true;
  b.replica.apply = async input => {
    if (race) { race = false; await rememberHiveFact(b.file, fact('new local addition', 'three')); }
    return applyLiveCloudArchive(b.file, input);
  };
  await assert.rejects(b.replica.syncOnce(), error => error.status === 409);
  assert.equal((await b.replica.syncOnce()).status, 'synced');
  assert.deepEqual((await readHiveMind(b.file)).memories.map(m => m.subject).sort(), ['new local addition', 'original', 'remote addition']);
});

test('competing edits are retained as an explicit conflict without overwriting either service', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  await rememberHiveFact(a.file, fact('shared', 'before')); await a.replica.syncOnce(); await b.replica.syncOnce();
  await rememberHiveFact(a.file, fact('shared', 'desktop correction')); await a.replica.syncOnce();
  await rememberHiveFact(b.file, fact('shared', 'auro correction'));
  const bytes = await fs.readFile(b.file), count = f.files.length;
  assert.equal((await b.replica.syncOnce()).status, 'conflict');
  assert.deepEqual(await fs.readFile(b.file), bytes);
  assert.equal(f.files.length, count);
  assert.equal((await readHiveMind(a.file)).memories[0].fact, 'desktop correction');
});

test('remote forget defeats a stale client correction and prevents resurrection', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  const original = await rememberHiveFact(a.file, fact('shared', 'before'));
  await a.replica.syncOnce(); await b.replica.syncOnce();
  await rememberHiveFact(b.file, fact('shared', 'stale correction'));
  await forgetHiveFact(a.file, original.id); await a.replica.syncOnce();
  assert.equal((await b.replica.syncOnce()).status, 'synced');
  assert.deepEqual((await readHiveMind(b.file)).memories, []);
});

test('a nonempty unbound join cannot overwrite either canonical store', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  await rememberHiveFact(a.file, fact('one', 'desktop')); await a.replica.syncOnce();
  await rememberHiveFact(b.file, fact('two', 'remote'));
  const bytes = await fs.readFile(b.file), count = f.files.length;
  await assert.rejects(b.replica.syncOnce(), /initial reconciliation/);
  assert.deepEqual(await fs.readFile(b.file), bytes); assert.equal(f.files.length, count);
});

test('retained files larger than the projection limit survive encrypted cache replacement and restart', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed');
  await importBrainFile(a.file, { scope: 'general', title: 'synthetic binary fixture', filename: 'fixture.bin',
    base64: Buffer.alloc(3 * 1024 * 1024, 13).toString('base64'), source: { threadId: 'test', provider: 'test', type: 'user' } });
  assert.equal((await a.replica.syncOnce()).status, 'synced');
  const cache = path.join(a.options.directory, 'replica.checkpoint');
  assert.ok((await fs.stat(cache)).size > 4_000_000);
  const restarted = new CloudReplica({ ...a.options, bootstrap: 'resume' });
  assert.equal((await restarted.syncOnce()).status, 'current');
});
