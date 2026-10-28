import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
process.env.HIVE_MIND_SEMANTIC = 'off';
import { CloudFileReplica } from '../src/cloud-file-replica.mjs';
import { startHiveMind } from '../src/service.mjs';
import { liveCloudSnapshot, applyLiveCloudArchive } from '../src/cloud-live.mjs';
import { rememberHiveFact, forgetHiveFact, readHiveMind } from '../src/core/store.ts';
import { saveBrainRecord } from '../src/brain.mjs';

const fact = (subject, value) => ({ scope: 'general', subject, fact: value, sourceThreadId: 'synthetic-file-test' });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-file-sync-'));
  const key = randomBytes(32), services = [], revisions = new Map([['revision-0', null]]);
  let version = 0, bytes = null;
  const remote = { revisions, writes: 0, bodyReads: 0,
    async read({ etag } = {}) {
      if (bytes && etag === `"version-${version}"`) return { unchanged: true, etag, revisionId: `revision-${version}` };
      remote.bodyReads++;
      return { bytes: bytes === null ? null : Buffer.from(bytes), etag: `"version-${version}"`, revisionId: `revision-${version}` };
    },
    async write(next, { etag }) {
      if (etag !== `"version-${version}"`) { const error = new Error('stale'); error.status = 412; throw error; }
      bytes = Buffer.from(next); version++; remote.writes++;
      revisions.set(`revision-${version}`, bytes);
      return { etag: `"version-${version}"`, revisionId: `revision-${version}` };
    },
    async purgeRevisions(ids) { for (const id of ids) { assert.notEqual(id, `revision-${version}`); revisions.delete(id); } },
  };
  t.after(async () => { for (const service of services) await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const client = async (name, bootstrap) => {
    const directory = path.join(root, name);
    const service = await startHiveMind({ stateDirectory: directory, token: randomBytes(32).toString('hex'), port: 0 }); services.push(service);
    const file = path.join(directory, 'hive-mind.json');
    const options = { transport: remote, key, workspace: 'synthetic-file-store', client: name,
      binding: { fileId: 'synthetic-file', folderId: 'synthetic-folder', expectedName: 'synthetic.enc', userId: 'synthetic-user', connectedAccountId: 'synthetic-account' },
      directory: path.join(directory, 'cloud-cache'), bootstrap,
      snapshot: () => liveCloudSnapshot(file), apply: input => applyLiveCloudArchive(file, input) };
    return { file, options, replica: new CloudFileReplica(options) };
  };
  return { remote, client };
}

test('seed, join and pull exchange independent edits with no redundant upload or history replay', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  await rememberHiveFact(a.file, fact('seed', 'one'));
  assert.equal((await a.replica.syncOnce()).status, 'synced');
  assert.equal((await b.replica.syncOnce()).status, 'synced');
  assert.equal(f.remote.writes, 1, 'an empty join is a pull, not another cloud revision');
  await rememberHiveFact(a.file, fact('desktop', 'two')); await rememberHiveFact(b.file, fact('auro', 'three'));
  await b.replica.syncOnce(); await a.replica.syncOnce(); await b.replica.syncOnce();
  assert.deepEqual((await readHiveMind(a.file)).memories, (await readHiveMind(b.file)).memories);
  const writes = f.remote.writes;
  const reads = f.remote.bodyReads;
  assert.equal((await a.replica.syncOnce()).status, 'current'); assert.equal(f.remote.writes, writes);
  assert.equal(f.remote.bodyReads, reads, 'unchanged background polling must not redownload the full archive');
});

test('client consumption remains host-local across join, independent cursor updates and memory transfers', async t => {
  const f = await fixture(t), a = await f.client('desktop-cursors', 'seed'), b = await f.client('auro-cursors', 'join');
  await rememberHiveFact(a.file, fact('cursor fixture', 'one'));
  let state = await readHiveMind(a.file);
  const input = { kind: 'client', scope: 'general', title: 'Synthetic reader',
    source: {threadId:'synthetic-reader',provider:'test',type:'agent'},
    data: {consumedSequence:1,consumedStreamId:state.continuity.streamId,deliveredIds:[state.memories[0].id],usedIds:[]} };
  const client = await saveBrainRecord(a.file,input);
  assert.equal((await a.replica.syncOnce()).status,'synced');
  assert.equal((await b.replica.syncOnce()).status,'synced');assert.equal(f.remote.writes,1);
  state=await readHiveMind(b.file);let local=state.continuity.records.find(r=>r.id===client.id);
  assert.equal(local.data.consumedSequence,0);assert.equal(local.data.consumedStreamId,state.continuity.streamId);
  assert.deepEqual(local.data.deliveredIds,[]);
  await saveBrainRecord(b.file,{...input,id:local.id,revision:local.revision,data:{...local.data,consumedSequence:1,usedIds:[state.memories[0].id]}});
  assert.equal((await b.replica.syncOnce()).status,'current');assert.equal(f.remote.writes,1,'cursor changes do not upload another archive');
  await rememberHiveFact(b.file,fact('independent remote note','two'));
  await b.replica.syncOnce();await a.replica.syncOnce();await b.replica.syncOnce();
  const desktop=await readHiveMind(a.file),auro=await readHiveMind(b.file);
  assert.equal(desktop.memories.length,2);assert.equal(auro.memories.length,2);
  const desktopClient=desktop.continuity.records.find(r=>r.id===client.id),auroClient=auro.continuity.records.find(r=>r.id===client.id);
  assert.equal(desktopClient.data.consumedSequence,1);assert.deepEqual(desktopClient.data.deliveredIds,input.data.deliveredIds);
  assert.deepEqual(desktopClient.data.usedIds,[]);assert.equal(auroClient.data.usedIds.length,1);
  assert.notEqual(desktopClient.data.consumedStreamId,auroClient.data.consumedStreamId);
  const writes=f.remote.writes;assert.equal((await a.replica.syncOnce()).status,'current');assert.equal(f.remote.writes,writes);
  await forgetHiveFact(b.file,auro.memories.find(m=>m.subject==='cursor fixture').id);
  await b.replica.syncOnce();await a.replica.syncOnce();
  const afterForget=(await readHiveMind(a.file)).continuity.records.find(r=>r.id===client.id);
  assert.deepEqual(afterForget.data.deliveredIds,[],'local cursor cannot retain references to remotely forgotten content');
});

test('a stale conditional write rebases independent edits from durable pending state', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  await rememberHiveFact(a.file, fact('seed', 'one')); await a.replica.syncOnce(); await b.replica.syncOnce();
  await rememberHiveFact(a.file, fact('desktop', 'two')); await rememberHiveFact(b.file, fact('auro', 'three'));
  const write = f.remote.write; let race = true;
  f.remote.write = async (...args) => { if (race) { race = false; await b.replica.syncOnce(); } return write(...args); };
  assert.equal((await a.replica.syncOnce()).status, 'retry');
  assert.equal((await a.replica.syncOnce()).status, 'synced');
  await b.replica.syncOnce();
  assert.deepEqual((await readHiveMind(a.file)).memories.map(m => m.subject).sort(), ['auro', 'desktop', 'seed']);
  assert.deepEqual((await readHiveMind(a.file)).memories, (await readHiveMind(b.file)).memories);
});

test('uncertain accepted write is recognized after restart without replay or another version', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), write = f.remote.write;
  await rememberHiveFact(a.file, fact('seed', 'one'));
  f.remote.write = async (...args) => { await write(...args); throw new Error('lost acknowledgement'); };
  await assert.rejects(a.replica.syncOnce(), /acknowledgement/);
  f.remote.write = write;
  const restarted = new CloudFileReplica({ ...a.options, bootstrap: 'resume' });
  assert.equal((await restarted.syncOnce()).status, 'synced'); assert.equal(f.remote.writes, 1);
});

test('offline pending work survives remote forget, while retained obsolete revisions are deleted', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  const original = await rememberHiveFact(a.file, fact('erase', 'private synthetic text'));
  await a.replica.syncOnce(); await b.replica.syncOnce();
  await rememberHiveFact(b.file, fact('unsent', 'keep this'));
  const write = f.remote.write; f.remote.write = async () => { throw new Error('offline'); };
  await assert.rejects(b.replica.syncOnce(), /offline/); f.remote.write = write;
  await forgetHiveFact(a.file, original.id);
  assert.equal((await a.replica.syncOnce()).historyErasure.erased, true);
  assert.equal(f.remote.revisions.size, 1);
  await b.replica.syncOnce(); await a.replica.syncOnce();
  assert.deepEqual((await readHiveMind(a.file)).memories.map(m => m.subject), ['unsent']);
  assert.deepEqual((await readHiveMind(b.file)).memories.map(m => m.subject), ['unsent']);
});

test('local forget replaces an unaccepted pending seed before any stale bytes are uploaded', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), write = f.remote.write;
  const original = await rememberHiveFact(a.file, fact('erase', 'private synthetic text'));
  f.remote.write = async () => { throw new Error('offline'); }; await assert.rejects(a.replica.syncOnce(), /offline/);
  f.remote.write = write; await forgetHiveFact(a.file, original.id);
  assert.equal((await a.replica.syncOnce()).historyErasure.erased, true);
  const remote = await a.replica.readRemote();
  assert.deepEqual(remote.archive.store.memories, []); assert.equal(f.remote.writes, 1);
});

test('cleanup failure remains explicit and retries without another data write', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed');
  const original = await rememberHiveFact(a.file, fact('erase', 'private synthetic text')); await a.replica.syncOnce();
  const purge = f.remote.purgeRevisions; f.remote.purgeRevisions = async () => { throw new Error('provider unavailable'); };
  await forgetHiveFact(a.file, original.id);
  const result = await a.replica.syncOnce(); assert.equal(result.historyErasure.erased, false);
  const writes = f.remote.writes; f.remote.purgeRevisions = purge;
  assert.equal((await a.replica.syncOnce()).historyErasure.erased, true); assert.equal(f.remote.writes, writes);
});

test('offline cached merge base still works after obsolete cloud versions have been pruned', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  await rememberHiveFact(a.file, fact('seed', 'one')); await a.replica.syncOnce(); await b.replica.syncOnce();
  for (let i = 0; i < 6; i++) { await rememberHiveFact(b.file, fact('remote', `revision-${i}`)); await b.replica.syncOnce(); }
  assert.ok(f.remote.revisions.size <= 4);
  await rememberHiveFact(a.file, fact('offline', 'keep this too')); await a.replica.syncOnce();
  assert.deepEqual((await readHiveMind(a.file)).memories.map(m => m.subject).sort(), ['offline', 'remote', 'seed']);
});

test('competing edits and nonempty unbound join preserve both stores', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  await rememberHiveFact(a.file, fact('seed', 'one')); await a.replica.syncOnce(); await b.replica.syncOnce();
  await rememberHiveFact(a.file, fact('seed', 'desktop correction')); await rememberHiveFact(b.file, fact('seed', 'remote correction'));
  await b.replica.syncOnce(); const before = await fs.readFile(a.file);
  assert.equal((await a.replica.syncOnce()).status, 'conflict'); assert.deepEqual(await fs.readFile(a.file), before);
  const c = await f.client('unbound', 'join'); await rememberHiveFact(c.file, fact('other', 'unrelated'));
  const untouched = await fs.readFile(c.file); await assert.rejects(c.replica.syncOnce(), /initial reconciliation/);
  assert.deepEqual(await fs.readFile(c.file), untouched);
});

test('pending rebase keeps a newer remote correction instead of mistaking the old pulled value for a local edit', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  await rememberHiveFact(a.file, fact('shared', 'zero')); await a.replica.syncOnce(); await b.replica.syncOnce();
  await rememberHiveFact(b.file, fact('shared', 'one')); await b.replica.syncOnce();
  await rememberHiveFact(a.file, fact('unsent', 'keep'));
  const write = f.remote.write; f.remote.write = async () => { throw new Error('offline'); };
  await assert.rejects(a.replica.syncOnce(), /offline/); f.remote.write = write;
  await rememberHiveFact(b.file, fact('shared', 'two')); await b.replica.syncOnce();
  await a.replica.syncOnce();
  const store = await readHiveMind(a.file);
  assert.equal(store.memories.find(m => m.subject === 'shared').fact, 'two');
  assert.equal(store.memories.find(m => m.subject === 'unsent').fact, 'keep');
});

test('forget after an uncertain accepted upload immediately replaces that cloud version and purges it', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), write = f.remote.write;
  const original = await rememberHiveFact(a.file, fact('erase', 'private synthetic text'));
  f.remote.write = async (...args) => { await write(...args); throw new Error('lost acknowledgement'); };
  await assert.rejects(a.replica.syncOnce(), /acknowledgement/); f.remote.write = write;
  await forgetHiveFact(a.file, original.id);
  assert.equal((await a.replica.syncOnce()).historyErasure.erased, true);
  assert.deepEqual((await a.replica.readRemote()).archive.store.memories, []);
  assert.equal(f.remote.revisions.size, 1);
});

test('an explicit re-remember survives a pending-write rebase after earlier subject deletion', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  const original = await rememberHiveFact(a.file, fact('shared', 'old')); await a.replica.syncOnce(); await b.replica.syncOnce();
  await forgetHiveFact(a.file, original.id); await a.replica.syncOnce(); await b.replica.syncOnce();
  const replacement = await rememberHiveFact(b.file, fact('shared', 'explicit replacement'));
  const write = f.remote.write; f.remote.write = async () => { throw new Error('offline'); };
  await assert.rejects(b.replica.syncOnce(), /offline/); f.remote.write = write;
  await rememberHiveFact(a.file, fact('other', 'independent')); await a.replica.syncOnce();
  await b.replica.syncOnce(); await a.replica.syncOnce();
  assert.equal((await readHiveMind(a.file)).memories.find(m => m.subject === 'shared').id, replacement.id);
});

test('failed erasure cleanup remains requested across a later application-data write', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed');
  const original = await rememberHiveFact(a.file, fact('erase', 'private synthetic text')); await a.replica.syncOnce();
  const purge = f.remote.purgeRevisions; f.remote.purgeRevisions = async () => { throw new Error('cleanup unavailable'); };
  await forgetHiveFact(a.file, original.id); await a.replica.syncOnce();
  await rememberHiveFact(a.file, fact('next edit', 'retained'));
  assert.equal((await a.replica.syncOnce()).historyErasure.erased, false);
  f.remote.purgeRevisions = purge;
  assert.equal((await a.replica.syncOnce()).historyErasure.erased, true);
  assert.equal(f.remote.revisions.size, 1);
});

test('changing a cached file/account binding rejects even if a copied cloud file has the same instance ID', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed');
  await rememberHiveFact(a.file, fact('seed', 'one')); await a.replica.syncOnce();
  const copied = new CloudFileReplica({ ...a.options, bootstrap: 'resume', binding: { ...a.options.binding, fileId: 'other-file' } });
  const before = await fs.readFile(a.file), writes = f.remote.writes;
  await assert.rejects(copied.syncOnce(), /binding changed/);
  assert.deepEqual(await fs.readFile(a.file), before); assert.equal(f.remote.writes, writes);
});

test('a new empty client joins after forget without redundant upload or stale resurrection', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed');
  const original = await rememberHiveFact(a.file, fact('erase', 'private synthetic text'));
  await rememberHiveFact(a.file, fact('keep', 'retained')); await a.replica.syncOnce();
  await forgetHiveFact(a.file, original.id); await a.replica.syncOnce();
  const writes = f.remote.writes, b = await f.client('newcomer', 'join');
  await b.replica.syncOnce(); assert.equal(f.remote.writes, writes);
  assert.deepEqual((await readHiveMind(b.file)).memories.map(m => m.subject), ['keep']);
});

test('remote forget sanitizes cached history and pending ciphertext even when an unrelated edit stays conflicted', async t => {
  const f = await fixture(t), a = await f.client('desktop', 'seed'), b = await f.client('auro', 'join');
  const secret = await rememberHiveFact(a.file, fact('private subject fixture', 'private body fixture'));
  await rememberHiveFact(a.file, fact('shared', 'before')); await a.replica.syncOnce(); await b.replica.syncOnce();
  await rememberHiveFact(b.file, fact('shared', 'remote correction'));
  const write = f.remote.write; f.remote.write = async () => { throw new Error('offline'); };
  await assert.rejects(b.replica.syncOnce(), /offline/); f.remote.write = write;
  await forgetHiveFact(a.file, secret.id); await rememberHiveFact(a.file, fact('shared', 'desktop correction')); await a.replica.syncOnce();
  assert.equal((await b.replica.syncOnce()).status, 'conflict');
  assert.equal((await readHiveMind(b.file)).memories.some(m => m.id === secret.id), false);
  const cached = await b.replica.load();
  const pending = b.replica.journal.decode(cached.pending.id, Buffer.from(cached.pending.bytes, 'base64')).archive;
  for (const archive of [cached.base, cached.pending.localBefore, cached.pending.remoteBefore, pending]) {
    assert.equal(JSON.stringify(archive).includes('private body fixture'), false);
    assert.equal(JSON.stringify(archive).includes('private subject fixture'), false);
  }
});
