import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createConnector, readConnection, runStdio, validateOptions } from '../plugin/runtime.mjs';
import { exportPlugin, PLUGIN_FILES } from '../src/plugin-package.mjs';
import { startHiveMind } from '../src/service.mjs';
process.env.HIVE_MIND_SEMANTIC = 'off';
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const tool = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const data = reply => {
  assert.ok(!reply.error, JSON.stringify(reply));
  assert.ok(!reply.result.isError, JSON.stringify(reply));
  return JSON.parse(reply.result.content[0].text);
};
const fact = { scope: 'project', project: 'Nebula', subject: 'Cooling choice', fact: 'Copper fins.' };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-plugin-'));
  const token = randomBytes(32).toString('hex'), readToken = randomBytes(32).toString('hex');
  const connectionFile = path.join(directory, 'connection.json');
  let service;
  async function start() {
    service = await startHiveMind({ stateDirectory: path.join(directory, 'state'), token, readToken, port: 0 });
    await fs.writeFile(connectionFile, JSON.stringify({ mcp: `${service.origin}/mcp`, token }));
  }
  await start();
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, connectionFile, token, readToken,
    connector: (extra = {}) => createConnector({ version: 1, access: 'write', connectionFile, ...extra }),
    async restart() { await service.close(); await start(); },
    async request(route, body) {
      return fetch(`${service.origin}${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
  };
}
function processClient(t, destination, env = {}) {
  const child = spawn(process.execPath, [path.join(destination, 'runtime.mjs')], {
    cwd: os.tmpdir(), env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '', sequence = 0;
  child.stderr.on('data', b => { stderr += b; });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const reply = JSON.parse(line); pending.get(reply.id)?.resolve(reply); pending.delete(reply.id); });
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error(stderr || 'Adapter exited.')); pending.clear(); });
  t.after(() => { lines.close(); child.kill(); });
  return (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('MCP process timed out.')); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: err => { clearTimeout(timeout); reject(err); } });
    child.stdin.write(JSON.stringify(rpc(method, params, id)) + '\n');
  });
}

test('two exported stdio clients share save, correction, forget and service restart without a cache', async t => {
  const f = await fixture(t);
  const destination = path.join(f.directory, 'export with spaces');
  await exportPlugin({ destination, connectionFile: f.connectionFile, access: 'write' });
  const a = processClient(t, destination), b = processClient(t, destination);
  const params = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } };
  assert.equal((await a('initialize', params)).result.serverInfo.name, 'Hive Mind Connector');
  await b('initialize', params);
  const saved = data(await a('tools/call', { name: 'hive_mind_remember', arguments: fact })).memory;
  assert.equal(data(await b('tools/call', { name: 'hive_mind_recall', arguments: { query: 'Cooling' } })).memories[0].fact, fact.fact);
  data(await b('tools/call', { name: 'hive_mind_remember', arguments: { ...fact, fact: 'Aluminum fins.' } }));
  assert.equal(data(await a('tools/call', { name: 'hive_mind_recall', arguments: { query: 'Cooling' } })).memories[0].fact, 'Aluminum fins.');
  await f.restart();
  assert.equal(data(await b('tools/call', { name: 'hive_mind_recall', arguments: { query: 'Cooling' } })).memories[0].id, saved.id);
  data(await a('tools/call', { name: 'hive_mind_forget', arguments: { id: saved.id } }));
  assert.equal(data(await b('tools/call', { name: 'hive_mind_recall', arguments: { query: 'Cooling' } })).memories.length, 0);
});

test('read-only hides write tools and rejects mixed-action writes before mutation', async t => {
  const f = await fixture(t), read = f.connector({ access: 'read' });
  const tools = (await read(rpc('tools/list'))).result.tools;
  assert.ok(!tools.some(t => t.name === 'hive_mind_remember'));
  assert.deepEqual(tools.find(t => t.name === 'hive_mind_record').inputSchema.properties.action.enum, ['list']);
  assert.equal((await read(tool('hive_mind_remember', fact))).error.code, -32602);
  assert.equal((await read(tool('hive_mind_record', { action: 'save' }))).result.isError, true);
  assert.equal(data(await read(tool('hive_mind_recall', { query: 'Cooling' }))).memories.length, 0);
});

test('selected projects filter cross-project recall and reject foreign writes/IDs and linked reference tools', async t => {
  const f = await fixture(t), full = f.connector(), scoped = f.connector({ projects: ['Nebula'] });
  const own = data(await full(tool('hive_mind_remember', fact))).memory;
  const foreign = data(await full(tool('hive_mind_remember', { ...fact, project: 'Other' }))).memory;
  data(await full(tool('hive_mind_remember', { scope: 'general', subject: fact.subject, fact: 'General choice.' })));
  assert.deepEqual(data(await scoped(tool('hive_mind_recall', { query: 'Cooling', project: 'Other' }))).memories.map(m => m.id), [own.id]);
  assert.equal((await scoped(tool('hive_mind_forget', { id: foreign.id }))).result.isError, true);
  assert.equal((await scoped(tool('hive_mind_remember', { ...fact, project: 'Other' }))).result.isError, true);
  assert.equal((await scoped(tool('hive_mind_working_context', { taskId: 'foreign' }))).error.code, -32602);
  assert.equal((await scoped(rpc('tools/list'))).result.tools.length, 3);
  assert.equal(data(await f.connector({ projects: ['Nebula'], includeGeneral: true })(tool('hive_mind_recall', { query: 'Cooling' }))).memories.length, 2);
  assert.equal(data(await full(tool('hive_mind_recall', { query: 'Cooling' }))).memories.length, 3);
});

test('all-project connector retains neighboring task/revision and read-only record-list paths', async t => {
  const f = await fixture(t), full = f.connector();
  const record = data(await full(tool('hive_mind_record', { action: 'save', kind: 'task', scope: 'project', project: 'Nebula', title: 'Synthetic task', data: { objective: 'Check shared continuity', status: 'active' }, source: { provider: 'test', threadId: 'synthetic-plugin', type: 'agent' } })));
  assert.ok(record.id);
  const list = data(await f.connector({ access: 'read' })(tool('hive_mind_record', { action: 'list', id: record.id })));
  assert.equal(list.records[0].id, record.id);
  assert.equal((await full(tool('hive_mind_record', { action: 'save', id: record.id, revision: 'stale', kind: 'task', scope: 'project', project: 'Nebula', title: 'Synthetic task', data: { objective: 'Wrong revision' } }))).result.isError, true);
});

test('upstream read credentials still reject writes even when the adapter is configured writable', async t => {
  const f = await fixture(t);
  const value = JSON.parse(await fs.readFile(f.connectionFile)); value.token = f.readToken;
  await fs.writeFile(f.connectionFile, JSON.stringify(value));
  assert.equal((await f.connector()(tool('hive_mind_remember', fact))).result.isError, true);
});

test('invalid endpoint, credential and redirect fail closed without sending secrets to another host', async t => {
  const f = await fixture(t);
  for (const mcp of ['http://example.com/mcp', 'https://user:password@example.com/mcp', 'https://example.com/mcp?key=1', 'file:///mcp']) {
    await fs.writeFile(f.connectionFile, JSON.stringify({ mcp, token: f.token }));
    await assert.rejects(readConnection({ connectionFile: f.connectionFile }));
  }
  await f.restart();
  let calls = 0;
  const connector = createConnector({ version: 1, access: 'read', connectionFile: f.connectionFile }, {
    fetchImpl: async (url, options) => { calls++; assert.equal(options.redirect, 'error'); return new Response('do not echo this', { status: 401 }); },
  });
  const reply = await connector(rpc('initialize'));
  assert.match(reply.error.message, /HTTP 401/);
  assert.ok(!JSON.stringify(reply).includes(f.token));
  assert.ok(!JSON.stringify(reply).includes('do not echo this'));
  assert.equal(calls, 1);
});

test('invalid settings and existing output are rejected; exported files contain no bearer token', async t => {
  const f = await fixture(t), destination = path.join(f.directory, 'package');
  for (const options of [{ version: 2, access: 'read' }, { version: 1, access: 'write', projects: [] }, { version: 1, access: 'read', token: 'extra' }]) assert.throws(() => validateOptions(options));
  await exportPlugin({ destination, connectionFile: f.connectionFile, access: 'read', projects: ['Nebula'] });
  await assert.rejects(exportPlugin({ destination }), { code: 'EEXIST' });
  for (const name of [...PLUGIN_FILES, 'START_HERE.txt', 'mcp.local.json', 'codex.toml']) assert.ok(!(await fs.readFile(path.join(destination, name), 'utf8')).includes(f.token));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(destination, 'connector.json'))).projects, ['Nebula']);
});

test('stdio handles partial frames, invalid JSON and notifications without diagnostic stdout', async () => {
  let output = '';
  const stream = new Writable({ write(chunk, encoding, done) { output += chunk; done(); } });
  await runStdio(async message => message.id === undefined ? null : { jsonrpc: '2.0', id: message.id, result: {} },
    Readable.from([Buffer.from('{bad}\n{"jsonrpc":"2.0","id":'), Buffer.from('2,"method":"ping"}\n{"method":"notifications/initialized"}\n')]), stream);
  const replies = output.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 2);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].id, 2);
});

test('plugin, marketplace and desktop release versions agree', async () => {
  const root = new URL('../', import.meta.url);
  const load = async name => JSON.parse(await fs.readFile(new URL(name, root), 'utf8'));
  const pkg = await load('package.json');
  assert.equal((await load('plugin/.codex-plugin/plugin.json')).version, pkg.version);
  assert.equal((await load('plugin/.claude-plugin/plugin.json')).version, pkg.version);
  assert.equal((await load('.claude-plugin/marketplace.json')).plugins[0].version, pkg.version);
  assert.equal((await load('package-lock.json')).version, pkg.version);
});
