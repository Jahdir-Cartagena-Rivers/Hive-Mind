import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { startCloudHost } from '../scripts/cloud-host.mjs';
import { startHiveMind } from '../src/service.mjs';
import { createRemoteConnector } from '../src/remote-connector.mjs';
import { createCloudScheduler } from '../src/cloud-scheduler.mjs';
import { CloudFileReplica } from '../src/cloud-file-replica.mjs';
import { liveCloudSnapshot, applyLiveCloudArchive } from '../src/cloud-live.mjs';
process.env.HIVE_MIND_SEMANTIC = 'off';
const tool = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const fact = { scope: 'project', project: 'Nebula', subject: 'Synthetic standing answer', fact: 'Synthetic choice A' };
async function fixture(t) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-writer-'));
  const token = randomBytes(32).toString('hex'); let service, state = 'synced', calls = 0, failAfter = Infinity;
  await fs.writeFile(path.join(profile, 'service-token'), token);
  const start = async () => {
    service = await startHiveMind({ stateDirectory: path.join(profile, 'data'), token, readToken: 'r'.repeat(32), port: 0,
      cloudSyncEnabled: true, cloudControl: { status: () => ({ state }), flush: async () => ({ state: ++calls >= failAfter ? 'offline' : state }) } });
    await fs.writeFile(path.join(profile, 'connector-connection.json'), JSON.stringify({ origin: service.origin, token }));
  };
  await start();
  t.after(async () => { await service.close(); await fs.rm(profile, { recursive: true, force: true }); });
  return { profile, token, origin: () => service.origin, setState: v => { state = v; }, failAfter: v => { failAfter = v; },
    async restart() { await service.close(); await start(); },
  };
}
const value = r => JSON.parse(r.result.content[0].text);
const receipt = r => JSON.parse(r.result.content.at(-1).text).hiveWriteReceipt;

test('bound writable connector saves/corrects/forgets and independently reconnects after host restart', async t => {
  const f = await fixture(t);
  const a = await createRemoteConnector({ profile: f.profile, access: 'write' });
  const b = await createRemoteConnector({ profile: f.profile, access: 'read' });
  assert.equal(a.ownsHost, false);
  const tools = await a.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(tools.result.tools.some(t => t.name === 'hive_mind_cloud_sync'));
  const saved = await a.handle(tool('hive_mind_remember', fact));
  assert.deepEqual(receipt(saved), { localCommitted: true, driveConfirmed: true, state: 'synced' });
  const id = value(saved).memory.id;
  assert.equal(value(await b.handle(tool('hive_mind_recall', { query: fact.subject }))).memories[0].fact, fact.fact);
  await a.handle(tool('hive_mind_remember', { ...fact, fact: 'Synthetic choice B' }));
  await f.restart();
  assert.equal(value(await b.handle(tool('hive_mind_recall', { query: fact.subject }))).memories[0].fact, 'Synthetic choice B');
  assert.equal(receipt(await a.handle(tool('hive_mind_forget', { id }))).driveConfirmed, true);
  assert.equal(value(await b.handle(tool('hive_mind_recall', { query: fact.subject }))).memories.length, 0);
  await a.close(); // Closing an attached connector must not stop the existing host.
  assert.equal((await fetch(f.origin() + '/health')).status, 200);
});
test('offline preflight refuses new writes; failed postflush reports retained local data without claiming shared success', async t => {
  const f = await fixture(t), a = await createRemoteConnector({ profile: f.profile, access: 'write' });
  f.setState('offline');
  const rejected = await a.handle(tool('hive_mind_remember', fact));
  assert.equal(value(rejected).localCommitted, false);
  assert.equal(value(await a.handle(tool('hive_mind_sync', {}))).localCommitted, false);
  assert.equal(value(await a.handle(tool('hive_mind_recall', { query: fact.subject }))).memories.length, 0);
  f.setState('conflict');
  assert.equal(value(await a.handle(tool('hive_mind_remember', fact))).localCommitted, false);
  f.setState('synced'); f.failAfter(5);
  const retained = await a.handle(tool('hive_mind_remember', fact));
  assert.equal(retained.result.isError, true);
  assert.equal(receipt(retained).localCommitted, true);
  assert.equal(receipt(retained).driveConfirmed, false);
  assert.match(receipt(retained).message, /Do not resubmit/);
  assert.equal(value(await a.handle(tool('hive_mind_recall', { query: fact.subject }))).memories.length, 1);
  f.failAfter(Infinity);
  assert.equal(value(await a.handle(tool('hive_mind_cloud_sync', { action: 'flush' }))).state, 'synced');
  assert.equal(value(await a.handle(tool('hive_mind_recall', { query: fact.subject }))).memories.length, 1);
});
test('read-only and wrong project paths remain rejected; coordinator flush rejects a read token', async t => {
  const f = await fixture(t);
  const a = await createRemoteConnector({ profile: f.profile });
  assert.ok((await a.handle(tool('hive_mind_remember', fact))).error);
  assert.equal((await a.handle(tool('hive_mind_cloud_sync', { action: 'flush' }))).result.isError, true);
  const scoped = await createRemoteConnector({ profile: f.profile, access: 'write', projects: ['Other'] });
  assert.equal((await scoped.handle(tool('hive_mind_remember', fact))).result.isError, true);
  assert.equal((await fetch(f.origin() + '/v1/cloud/flush', { method: 'POST', headers: { authorization: 'Bearer ' + 'r'.repeat(32), 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const packet = JSON.parse(await fs.readFile(path.join(f.profile, 'connector-connection.json')));
  packet.token = 'wrong'.repeat(16); await fs.writeFile(path.join(f.profile, 'connector-connection.json'), JSON.stringify(packet));
  await assert.rejects(createRemoteConnector({ profile: f.profile, access: 'write' }), /does not match/);
});

test('host-started connector can reopen an existing opted-in profile after a restart without a second service', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-command-host-'));
  let host, connector;
  t.after(async () => { await connector?.close(); await host?.close(); await fs.rm(profile, { recursive: true, force: true }); });
  await fs.writeFile(path.join(profile, 'drive-sync.json'), JSON.stringify({ version: 1, enabled: true, workspace: 'synthetic', client: 'synthetic-command', bootstrap: 'join',
    protectedKeyFile: path.join(profile, 'missing-key'), transportOptions: { folderId: 'synthetic', fileId: 'synthetic', expectedName: 'synthetic.enc', userId: 'synthetic', connectedAccountId: 'synthetic' } }));
  await assert.rejects(createRemoteConnector({ profile, access: 'write', projects: [] }), /Invalid connector settings/);
  await assert.rejects(fs.stat(path.join(profile, 'connector-connection.json')), { code: 'ENOENT' });
  host = await startCloudHost({ profile, port: 0 });
  const packet = JSON.parse(await fs.readFile(host.connectionFile));
  assert.equal(packet.token, await fs.readFile(path.join(profile, 'service-token'), 'utf8'));
  connector = await createRemoteConnector({ profile, access: 'read' });
  assert.equal(connector.ownsHost, false); await connector.close();
  await host.close();
  connector = await createRemoteConnector({ profile, access: 'read' });
  assert.equal(connector.ownsHost, true);
  assert.equal(value(await connector.handle(tool('hive_mind_recall', { query: 'synthetic' }))).memories.length, 0);
  await connector.close();
  const registration = path.join(profile, 'registration.json');
  const root = path.resolve(import.meta.dirname, '..');
  await promisify(execFile)(process.execPath, [path.join(root, 'scripts/prepare-remote-connector.mjs'), '--profile', profile, '--output', registration, '--access', 'write']);
  const config = JSON.parse(await fs.readFile(registration));
  assert.equal(config.mcpServers['hive-mind'].command, process.execPath);
  assert.ok(!JSON.stringify(config).includes(packet.token));
  const child = spawn(process.execPath, [path.join(root, 'scripts/remote-connector.mjs'), '--profile', profile, '--access', 'read'], { env: { ...process.env, HIVE_MIND_SEMANTIC: 'off' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; child.stdout.on('data', b => stdout.push(b)); child.stderr.on('data', b => stderr.push(b));
  const timer = setTimeout(() => child.kill(), 10000);
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-native', version: '1' } } }) + '\n');
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); clearTimeout(timer);
  assert.equal(code, 0, Buffer.concat(stderr).toString());
  const lines = Buffer.concat(stdout).toString().trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).result.serverInfo.name, 'Hive Mind Connector');
  assert.equal(JSON.parse(lines[0]).result.serverInfo.version, '0.6.0');
});
test('flush drains changes queued during an older worker pass before reporting synchronized', async () => {
  let resolveFirst, entered, count = 0;
  const first = new Promise(r => { resolveFirst = r; });
  const started = new Promise(r => { entered = r; });
  const scheduler = createCloudScheduler({ pollIntervalMs: 100000, minIntervalMs: 100000, debounceMs: 100000,
    run: async () => { count++; if (count === 1) { entered(); await first; } return { status: 'synced' }; } });
  const older = scheduler.syncNow(); await started;
  scheduler.changed(); const flushed = scheduler.flush(); resolveFirst(); await older;
  assert.equal((await flushed).state, 'synced'); assert.equal(count, 2);
  await scheduler.stop();
});

test('native writer receipt corresponds to actual encrypted replica transfer to an independent client', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-native-replica-'));
  const key = randomBytes(32), services = [], revisions = new Map();
  let bytes = null, version = 0;
  const transport = {
    async read() { return { bytes, etag: String(version), revisionId: String(version) }; },
    async write(next, { etag }) {
      if (etag !== String(version)) { const e = new Error('stale'); e.status = 412; throw e; }
      bytes = Buffer.from(next); version++; revisions.set(String(version), bytes);
      return { etag: String(version), revisionId: String(version) };
    },
    async purgeRevisions(ids) { for (const id of ids) { assert.notEqual(id, String(version)); revisions.delete(id); } },
  };
  t.after(async () => { for (const s of services) await s.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function client(name, bootstrap) {
    const profile = path.join(root, name); await fs.mkdir(profile);
    const token = randomBytes(32).toString('hex'), file = path.join(profile, 'data/hive-mind.json');
    let replica, state = 'pending';
    const flush = async () => { const result = await replica.syncOnce(); state = ['current', 'synced'].includes(result.status) ? 'synced' : result.status; return { state }; };
    const service = await startHiveMind({ stateDirectory: path.join(profile, 'data'), token, port: 0, cloudSyncEnabled: true,
      cloudControl: { status: () => ({ state }), flush } }); services.push(service);
    replica = new CloudFileReplica({ transport, key, workspace: 'synthetic-native', client: name, bootstrap,
      directory: path.join(profile, 'cache'), binding: { fileId: 'synthetic-file', folderId: 'synthetic-folder', expectedName: 'synthetic.enc', userId: 'synthetic-user', connectedAccountId: 'synthetic-account' },
      snapshot: () => liveCloudSnapshot(file), apply: input => applyLiveCloudArchive(file, input) });
    await fs.writeFile(path.join(profile, 'service-token'), token);
    await fs.writeFile(path.join(profile, 'connector-connection.json'), JSON.stringify({ origin: service.origin, token }));
    await flush();
    return { connector: await createRemoteConnector({ profile, access: 'write' }), flush };
  }
  const a = await client('a', 'seed'), b = await client('b', 'join');
  const saved = await a.connector.handle(tool('hive_mind_remember', fact));
  assert.equal(receipt(saved).driveConfirmed, true);
  assert.ok(!bytes.includes(Buffer.from(fact.fact)));
  await b.flush();
  assert.equal(value(await b.connector.handle(tool('hive_mind_recall', { query: fact.subject }))).memories[0].fact, fact.fact);
  const corrected = await b.connector.handle(tool('hive_mind_remember', { ...fact, fact: 'Synthetic choice B' }));
  assert.equal(receipt(corrected).driveConfirmed, true);
  await a.flush();
  assert.equal(value(await a.connector.handle(tool('hive_mind_recall', { query: fact.subject }))).memories[0].fact, 'Synthetic choice B');
  assert.equal(receipt(await a.connector.handle(tool('hive_mind_forget', { id: value(saved).memory.id }))).driveConfirmed, true);
  await b.flush();
  assert.equal(value(await b.connector.handle(tool('hive_mind_recall', { query: fact.subject }))).memories.length, 0);
  assert.equal(revisions.size, 1); // Existing erasure protocol removed tracked earlier snapshots.
});
