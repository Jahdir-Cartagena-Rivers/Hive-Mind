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
    async create(name, bytes) { files.push({ name, bytes, id: randomBytes(16).toString('hex') }); },
    async remove(id, name) { const index = files.findIndex(f => f.id === id && f.name === name); assert.ok(index >= 0); files.splice(index, 1); } };
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
  assert.ok(['synced', 'current'].includes((await b.replica.syncOnce()).status));
  assert.deepEqual((await readHiveMind(b.file)).memories, []);
  const cloud = await a.journal.inspect();
  assert.ok(cloud.erasures.memoryIds.includes(original.id));
  assert.equal(cloud.candidates.some(row => row.checkpoint.archive.store.memories.some(m => m.id === original.id)), false);
});

test('explicit new remember after observed forget survives old history and permanent ID markers', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  const original = await rememberHiveFact(a.file, fact('shared', 'before'));
  await a.replica.syncOnce(); await b.replica.syncOnce();
  await forgetHiveFact(a.file, original.id); await a.replica.syncOnce(); await b.replica.syncOnce();
  const replacement = await rememberHiveFact(b.file, fact('shared', 'explicit new statement'));
  assert.notEqual(replacement.id, original.id);
  await b.replica.syncOnce(); await a.replica.syncOnce();
  assert.deepEqual((await readHiveMind(a.file)).memories.map(m => m.id), [replacement.id]);
  assert.ok((await a.journal.inspect()).erasures.memoryIds.includes(original.id));
  assert.equal((await a.journal.inspect()).erasures.memoryIds.includes(replacement.id), false);
});

test('an offline pending upload is sanitized on reconnect without losing unrelated unsent edits', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  const original = await rememberHiveFact(a.file, fact('shared', 'before'));
  await a.replica.syncOnce(); await b.replica.syncOnce();
  await rememberHiveFact(b.file, fact('offline addition', 'keep this unsent edit'));
  const create = f.transport.create;
  f.transport.create = async () => { throw new Error('offline before upload'); };
  await assert.rejects(b.replica.syncOnce(), /offline/);
  f.transport.create = create;
  await forgetHiveFact(a.file, original.id); await a.replica.syncOnce();
  await b.replica.syncOnce();
  assert.deepEqual((await readHiveMind(b.file)).memories.map(m => m.subject), ['offline addition']);
  await a.replica.syncOnce();
  assert.deepEqual((await readHiveMind(a.file)).memories.map(m => m.subject), ['offline addition']);
});

test('a new empty client can join a store with existing history erasures', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed');
  const erased = await rememberHiveFact(a.file, fact('erase', 'private synthetic'));
  await rememberHiveFact(a.file, fact('keep', 'retained')); await a.replica.syncOnce();
  await forgetHiveFact(a.file, erased.id); await a.replica.syncOnce();
  const b = await f.client('newcomer', 'join');
  assert.ok(['current', 'synced'].includes((await b.replica.syncOnce()).status));
  assert.deepEqual((await readHiveMind(b.file)).memories.map(row => row.subject), ['keep']);
});

test('a local forget during an offline pending upload is published before retrying old content', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed');
  const original = await rememberHiveFact(a.file, fact('erase', 'private synthetic'));
  const create = f.transport.create;
  f.transport.create = async () => { throw new Error('offline before upload'); };
  await assert.rejects(a.replica.syncOnce(), /offline/);
  f.transport.create = create;
  await forgetHiveFact(a.file, original.id);
  await a.replica.syncOnce();
  const cloud = await a.journal.inspect();
  assert.ok(cloud.erasures.memoryIds.includes(original.id));
  assert.equal(cloud.candidates.some(row => row.checkpoint.archive.store.memories.length), false);
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
