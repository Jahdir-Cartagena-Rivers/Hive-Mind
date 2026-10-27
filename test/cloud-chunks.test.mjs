import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkedTransport } from '../src/cloud-chunks.mjs';
import { CloudJournal } from '../src/cloud-journal.mjs';
import { randomBytes } from 'node:crypto';

const fixture = () => {
  const files = [];
  const transport = { async list() { return files.map(({ id, name }) => ({ id, name })); },
    async read(id) { return files.find(f => f.id === id).bytes; },
    async create(name, bytes) { files.push({ id: String(files.length), name, bytes }); } };
  return { files, transport, chunks: new ChunkedTransport(transport, 512) };
};

test('large authenticated checkpoints round-trip through small immutable chunks and one final manifest', async () => {
  const f = fixture(), journal = new CloudJournal({ transport: f.chunks, key: randomBytes(32), workspace: 'synthetic', client: 'test' });
  const packet = journal.encode({ format: 'hive-mind.archive.v1', synthetic: randomBytes(8192).toString('base64') });
  await journal.publish(packet);
  assert.ok(f.files.filter(file => file.name.endsWith('.blob')).length > 1);
  assert.equal(f.files.filter(file => file.name.endsWith('.checkpoint')).length, 1);
  assert.deepEqual((await journal.inspect()).heads, [packet.id]);
  assert.deepEqual(await f.chunks.read(f.files.at(-1).id), packet.bytes);
});

test('uncertain part upload leaves no committed checkpoint and retries reuse already uploaded bytes', async () => {
  const f = fixture(), bytes = randomBytes(2048), create = f.transport.create;
  let interrupted = false;
  f.transport.create = async (...args) => { await create(...args); if (!interrupted) { interrupted = true; throw new Error('synthetic interruption'); } };
  await assert.rejects(f.chunks.create('checkpoint', bytes), /interruption/);
  assert.equal(f.files.length, 1);
  await f.chunks.create('checkpoint', bytes);
  assert.equal(f.files.length, 5);
  assert.deepEqual(await f.chunks.read(f.files.at(-1).id), bytes);
});

test('missing or corrupt duplicate chunks reject without returning partial plaintext', async () => {
  const f = fixture(), bytes = randomBytes(2048);
  await f.chunks.create('checkpoint', bytes);
  const descriptor = f.files.at(-1), first = f.files[0];
  f.files.push({ ...first, id: 'bad-copy', bytes: Buffer.from('corrupt') });
  await assert.rejects(f.chunks.read(descriptor.id), /integrity/);
  f.files.pop(); f.files.shift();
  await assert.rejects(f.chunks.read(descriptor.id), /missing chunks/);
});
