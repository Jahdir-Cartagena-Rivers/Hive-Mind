import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { CloudJournal } from '../src/cloud-journal.mjs';
import { DriveTransport } from '../src/drive-transport.mjs';

const archive = label => ({ format: 'hive-mind.archive.v1', store: { version: 1, memories: [{ fact: label }] }, images: {} });
const key = randomBytes(32);
const remote = () => {
  const files = [];
  return { files, async list() { return files.map(({ id, name }) => ({ id, name })); },
    async read(id) { return files.find(f => f.id === id).bytes; },
    async create(name, bytes) { files.push({ id: String(files.length), name, bytes }); } };
};
const client = (transport, name = 'desktop', overrides = {}) => new CloudJournal({ transport, key, workspace: 'test', client: name, ...overrides });

test('encrypts full checkpoint content and authenticates key, namespace, hash and format', () => {
  const a = client(remote());
  const prepared = a.encode(archive('private synthetic text'));
  assert.equal(prepared.bytes.includes('private synthetic text'), false);
  assert.deepEqual(a.decode(prepared.id, prepared.bytes).archive, archive('private synthetic text'));
  assert.throws(() => client(remote(), 'other', { key: randomBytes(32) }).decode(prepared.id, prepared.bytes), /authentication/);
  assert.throws(() => client(remote(), 'other', { workspace: 'wrong' }).decode(prepared.id, prepared.bytes), /authentication/);
  const corrupt = Buffer.from(prepared.bytes); corrupt[20] ^= 1;
  assert.throws(() => a.decode(prepared.id, corrupt), /authentication/);
  const future = Buffer.from(JSON.stringify({ version: 2 }));
  assert.throws(() => a.decode(createHash('sha256').update(future).digest('hex'), future), /authentication/);
  assert.throws(() => a.decode(prepared.id, Buffer.alloc(90 * 1024 * 1024 + 1)), /authentication/);
  assert.throws(() => a.encode(archive('x'), 'bad-parent'), /parent/);
});

test('round-trips a chain between two clients; idempotent retry and duplicate names preserve one logical event', async () => {
  const transport = remote(); const a = client(transport); const b = client(transport, 'auro');
  const first = a.encode(archive('one'));
  assert.equal((await a.publish(first)).conflict, false);
  assert.equal((await b.publish(first)).existing, true);
  const second = b.encode(archive('two'), first.id);
  await b.publish(second);
  transport.files.push({ ...transport.files[1], id: 'duplicate' });
  const state = await a.inspect();
  assert.deepEqual(state.heads, [second.id]);
  assert.equal(state.checkpoints.size, 2);
});

test('uncertain successful upload retries the exact bytes without creating another event', async () => {
  const transport = remote(); const original = transport.create;
  transport.create = async (...args) => { await original(...args); throw new Error('connection lost after commit'); };
  const a = client(transport); const prepared = a.encode(archive('one'));
  await assert.rejects(a.publish(prepared), /connection lost/);
  assert.equal((await a.publish(prepared)).existing, true);
  assert.equal(transport.files.length, 1);
});

test('concurrent writers preserve both branches and block further publishing', async () => {
  const transport = remote(); const a = client(transport); const b = client(transport, 'auro');
  const root = a.encode(archive('root')); await a.publish(root);
  const left = a.encode(archive('left'), root.id); const right = b.encode(archive('right'), root.id);
  // Emulate both writers passing preflight before either upload is visible.
  await transport.create(`hive-${left.id}.checkpoint`, left.bytes);
  await transport.create(`hive-${right.id}.checkpoint`, right.bytes);
  const state = await a.inspect();
  assert.equal(state.conflict, true); assert.equal(state.heads.length, 2);
  assert.equal(state.checkpoints.get(left.id).archive.store.memories[0].fact, 'left');
  assert.equal(state.checkpoints.get(right.id).archive.store.memories[0].fact, 'right');
  await assert.rejects(a.publish(a.encode(archive('next'), left.id)), /head changed/);
  assert.equal(transport.files.length, 3);
});

test('missing ancestor, corrupt duplicate, stale parent and unrelated root reject without mutation', async () => {
  const transport = remote(); const a = client(transport);
  const root = a.encode(archive('root')); await a.publish(root);
  await assert.rejects(a.publish(a.encode(archive('unrelated'))), /head changed/);
  const next = a.encode(archive('next'), root.id); await a.publish(next);
  await assert.rejects(a.publish(a.encode(archive('stale'), root.id)), /head changed/);
  transport.files.push({ ...transport.files[0], id: 'bad', bytes: Buffer.from('broken') });
  await assert.rejects(a.inspect(), /authentication/);
  transport.files.pop(); transport.files.shift();
  await assert.rejects(a.inspect(), /missing ancestor/);
});

test('Drive adapter paginates with exact opaque tokens and fails on incomplete/repeated pages', async () => {
  const urls = [];
  const transport = new DriveTransport({ folderId: 'private', token: async () => 'hidden',
    fetchImpl: async (url, options) => {
      urls.push(new URL(url)); assert.equal(options.headers.authorization, 'Bearer hidden');
      return Response.json(urls.length === 1 ? { files: [{ id: 'a', name: 'a' }], nextPageToken: 'opaque+/=' }
        : { files: [{ id: 'b', name: 'b' }] });
    } });
  assert.equal((await transport.list()).length, 2);
  assert.equal(urls[1].searchParams.get('pageToken'), 'opaque+/=');
  transport.fetch = async () => Response.json({ files: [], incompleteSearch: true });
  await assert.rejects(transport.list(), /incomplete/);
  transport.fetch = async () => Response.json({ files: [], nextPageToken: 'repeat' });
  await assert.rejects(transport.list(), /pagination/);
});

test('Drive upload pins HTTPS Google destination and never logs provider credential/error bodies', async () => {
  const calls = [];
  const transport = new DriveTransport({ folderId: 'private', token: async () => 'secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? new Response(null, { headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=opaque' } })
        : Response.json({ id: 'uploaded' });
    } });
  const name = `hive-${'a'.repeat(64)}.checkpoint`;
  assert.equal((await transport.create(name, Buffer.from('encrypted'))).id, 'uploaded');
  assert.equal(calls[1].options.method, 'PUT');
  transport.fetch = async () => new Response(null, { headers: { location: 'https://attacker.invalid/upload' } });
  await assert.rejects(transport.create(name, Buffer.from('x')), /invalid upload/);
  transport.fetch = async () => new Response('secret provider body', { status: 401 });
  await assert.rejects(transport.list(), error => /HTTP 401/.test(error.message) && !error.message.includes('secret'));
});
