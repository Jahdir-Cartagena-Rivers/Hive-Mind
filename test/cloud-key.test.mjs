import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { saveCloudKey, loadCloudKey, createKeyRecipient, sealKeyTransfer, receiveKeyTransfer,
  saveComposioCredential, loadComposioCredential, keyTransferFingerprint } from '../src/cloud-key.mjs';

let prior;
beforeEach(() => { prior = process.env.COMPOSIO_API_KEY; process.env.COMPOSIO_API_KEY = 'synthetic-host-protection-secret'; });
afterEach(() => { if (prior === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = prior; });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-key-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'cloud.protected.json'), workspace: 'synthetic-key-workspace', provider: 'host' };
}
const safe = (error, key) => {
  const text = `${error.message} ${JSON.stringify(error)}`;
  assert.equal(text.includes(process.env.COMPOSIO_API_KEY ?? 'not-a-key'), false);
  if (key) { assert.equal(text.includes(key.toString('base64')), false); assert.equal(text.includes(key.toString('hex')), false); }
  return true;
};

test('host-protected keys round trip without plaintext key or credential files and refuse overwrite', async t => {
  const f = await fixture(t), key = randomBytes(32);
  await saveCloudKey(key, f); assert.deepEqual(await loadCloudKey(f), key);
  const text = await fs.readFile(f.file, 'utf8');
  assert.equal(text.includes(key.toString('base64')), false); assert.equal(text.includes(process.env.COMPOSIO_API_KEY), false);
  await assert.rejects(saveCloudKey(randomBytes(32), f), { code: 'EEXIST' });
  assert.deepEqual(await loadCloudKey(f), key);
  await assert.rejects(loadCloudKey({ ...f, workspace: 'wrong-workspace' }), error => safe(error, key));
});

test('wrong host credential, unavailable credential and modified ciphertext fail without changing the file', async t => {
  const f = await fixture(t), key = randomBytes(32); await saveCloudKey(key, f);
  const before = await fs.readFile(f.file);
  process.env.COMPOSIO_API_KEY = 'synthetic-different-host-secret';
  await assert.rejects(loadCloudKey(f), error => safe(error, key));
  delete process.env.COMPOSIO_API_KEY;
  await assert.rejects(loadCloudKey(f), error => !error.message.includes(key.toString('base64')));
  assert.deepEqual(await fs.readFile(f.file), before);
  process.env.COMPOSIO_API_KEY = 'synthetic-host-protection-secret';
  const packet = JSON.parse(before); packet.payload.data = randomBytes(64).toString('base64');
  await fs.writeFile(f.file, JSON.stringify(packet)); await assert.rejects(loadCloudKey(f), error => safe(error, key));
});

test('X25519 transfer provisions the same master under an independent host credential and is idempotent', async t => {
  const f = await fixture(t), identityFile = path.join(f.directory, 'identity.protected.json'), key = randomBytes(32);
  process.env.COMPOSIO_API_KEY = 'synthetic-recipient-host-secret';
  const recipient = await createKeyRecipient({ ...f, file: identityFile });
  assert.deepEqual(await createKeyRecipient({ ...f, file: identityFile }), recipient);
  process.env.COMPOSIO_API_KEY = 'synthetic-independent-sender-secret';
  const envelope = sealKeyTransfer(key, recipient, { expectedRecipientFingerprint: recipient.fingerprint });
  const expectedTransferFingerprint = keyTransferFingerprint(envelope);
  assert.equal(JSON.stringify(envelope).includes(key.toString('base64')), false);
  assert.equal(JSON.stringify(envelope).includes(process.env.COMPOSIO_API_KEY), false);
  process.env.COMPOSIO_API_KEY = 'synthetic-recipient-host-secret';
  assert.deepEqual(await receiveKeyTransfer(envelope, { ...f, identityFile, expectedTransferFingerprint }), { installed: true, existing: false });
  assert.deepEqual(await loadCloudKey(f), key);
  assert.deepEqual(await receiveKeyTransfer(envelope, { ...f, identityFile, expectedTransferFingerprint }), { installed: true, existing: true });
});

test('wrong recipient, altered envelope and namespace changes preserve an existing master', async t => {
  const f = await fixture(t), key = randomBytes(32), identityFile = path.join(f.directory, 'identity.protected.json');
  const recipient = await createKeyRecipient({ ...f, file: identityFile });
  await saveCloudKey(key, f);
  const different = sealKeyTransfer(randomBytes(32), recipient, { expectedRecipientFingerprint: recipient.fingerprint }), before = await fs.readFile(f.file);
  await assert.rejects(receiveKeyTransfer(different, { ...f, identityFile, expectedTransferFingerprint: keyTransferFingerprint(different) }), error => safe(error, key));
  const valid = sealKeyTransfer(key, recipient, { expectedRecipientFingerprint: recipient.fingerprint });
  const otherIdentity = path.join(f.directory, 'other-identity.protected.json');
  await createKeyRecipient({ ...f, file: otherIdentity });
  await assert.rejects(receiveKeyTransfer(valid, { ...f, identityFile: otherIdentity,
    expectedTransferFingerprint: keyTransferFingerprint(valid) }), error => safe(error, key));
  for (const change of [{ workspace: 'wrong-workspace' }, { recipientFingerprint: 'a'.repeat(64) }, { data: randomBytes(32).toString('base64') }])
    await assert.rejects(receiveKeyTransfer({ ...valid, ...change }, { ...f, identityFile, expectedTransferFingerprint: keyTransferFingerprint(valid) }), error => safe(error, key));
  assert.throws(() => sealKeyTransfer(key, recipient), /Invalid recipient/);
  await assert.rejects(receiveKeyTransfer(valid, { ...f, identityFile }), /Key transfer failed/);
  assert.deepEqual(await fs.readFile(f.file), before);
});

test('symlink targets and malformed protected packets reject without following or replacing them', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, JSON.stringify({ format: 'future', payload: {} }));
  await assert.rejects(loadCloudKey(f), /Protected key could not be opened/);
  const directory = path.join(f.directory, 'linked'), target = path.join(f.directory, 'target'); await fs.mkdir(target);
  await fs.symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveCloudKey(randomBytes(32), { ...f, file: path.join(directory, 'key.json') }), /parent/);
  assert.deepEqual(await fs.readdir(target), []);
});

test('native Windows current-user DPAPI protects and reopens generated key material', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), key = randomBytes(32);
  await saveCloudKey(key, { ...f, provider: 'dpapi' });
  assert.deepEqual(await loadCloudKey(f), key);
  const packet = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(packet.provider, 'dpapi'); assert.equal(JSON.stringify(packet).includes(key.toString('base64')), false);
});

test('desktop connection credential is DPAPI protected and cannot be substituted for a cloud master', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), credential = 'synthetic-platform-project-credential';
  await saveComposioCredential(credential, { ...f, provider: 'dpapi' });
  assert.equal(await loadComposioCredential(f), credential);
  assert.equal((await fs.readFile(f.file, 'utf8')).includes(credential), false);
  await assert.rejects(loadCloudKey(f), /Protected key could not be opened/);
  await assert.rejects(saveComposioCredential(credential, { ...f, provider: 'host' }), /protected credential environment/);
});
