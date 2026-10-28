import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const FORMAT = 'hive.protected-key.v1';
const validWorkspace = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const b64 = (value, length) => {
  if (typeof value !== 'string' || value.length > 16384) throw new Error();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) throw new Error();
  return bytes;
};
function context(workspace, purpose) {
  if (!validWorkspace(workspace) || !['cloud-master', 'transfer-identity', 'composio-credential'].includes(purpose))
    throw new Error('Invalid protected key context.');
  return Buffer.from(`${FORMAT}:${workspace}:${purpose}`);
}
function seal(bytes, key, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function open(payload, key, aad) {
  const decipher = createDecipheriv('aes-256-gcm', key, b64(payload.iv, 12));
  decipher.setAAD(aad); decipher.setAuthTag(b64(payload.tag, 16));
  return Buffer.concat([decipher.update(b64(payload.data)), decipher.final()]);
}
function hostKey(salt, aad) {
  const secret = process.env.COMPOSIO_API_KEY;
  if (typeof secret !== 'string' || secret.length < 8 || /\s/u.test(secret))
    throw new Error('Protected host credential is unavailable.');
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), salt, aad, 32));
}

/** Windows current-user DPAPI, with values passed only through private process pipes. */
async function dpapi(bytes, decrypt) {
  if (process.platform !== 'win32') throw new Error('This key requires its original Windows user.');
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); ` +
    `$outputBytes=[Security.Cryptography.ProtectedData]::${operation}($inputBytes,[Text.Encoding]::UTF8.GetBytes('Hive Mind host protection v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($outputBytes))`;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let length = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(new Error('Windows protected-key operation failed.')) : resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 15000);
    child.on('error', () => finish(true)); child.stdin.on('error', () => finish(true));
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 16384) { child.kill(); finish(true); } else chunks.push(chunk);
    });
    child.on('close', code => {
      if (code !== 0) return finish(true);
      try {
        const result = b64(Buffer.concat(chunks).toString('utf8').trim());
        result.length ? finish(false, result) : finish(true);
      } catch { finish(true); }
    });
    child.stdin.end(bytes.toString('base64'));
  });
}

async function checkParents(file) {
  if (!path.isAbsolute(file ?? '')) throw new Error('Protected-key path must be absolute.');
  let directory = path.dirname(file);
  while (true) {
    const stat = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Invalid protected-key parent.');
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
async function readProtected(file) {
  await checkParents(file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('Invalid protected-key file.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function protectBytes(bytes, { file, workspace, purpose, provider = process.platform === 'win32' ? 'dpapi' : 'host' }) {
  const aad = context(workspace, purpose);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 4096 || !path.isAbsolute(file ?? ''))
    throw new Error('Invalid protected key material or path.');
  await checkParents(file);
  const plain = Buffer.from(JSON.stringify({ workspace, purpose, data: bytes.toString('base64') }));
  let payload;
  if (provider === 'dpapi') payload = { data: (await dpapi(plain, false)).toString('base64') };
  else if (provider === 'host') {
    const salt = randomBytes(32);
    payload = { ...seal(plain, hostKey(salt, aad), aad), salt: salt.toString('base64') };
  } else throw new Error('Unknown protected-key provider.');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await checkParents(file);
  await fs.writeFile(file, JSON.stringify({ format: FORMAT, workspace, purpose, provider, payload }), { flag: 'wx', mode: 0o600 });
}
async function unprotectBytes({ file, workspace, purpose }) {
  try {
    const aad = context(workspace, purpose), packet = await readProtected(file);
    if (packet.format !== FORMAT || packet.workspace !== workspace || packet.purpose !== purpose) throw new Error();
    let plain;
    if (packet.provider === 'dpapi') plain = await dpapi(b64(packet.payload.data), true);
    else if (packet.provider === 'host') plain = open(packet.payload, hostKey(b64(packet.payload.salt, 32), aad), aad);
    else throw new Error();
    const value = JSON.parse(plain.toString('utf8'));
    if (value.workspace !== workspace || value.purpose !== purpose) throw new Error();
    return b64(value.data);
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw new Error('Protected key could not be opened; preserve it and recover through the original host.');
  }
}

/** No raw key file: Windows uses DPAPI, headless hosts use a separate host-held secret. */
export async function saveCloudKey(key, options) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Cloud key must be exactly 32 bytes.');
  await protectBytes(key, { ...options, purpose: 'cloud-master' });
}
export async function loadCloudKey(options) {
  const key = await unprotectBytes({ ...options, purpose: 'cloud-master' });
  if (key.length !== 32) throw new Error('Invalid protected cloud key length.');
  return key;
}

/** Desktop only. Headless hosts keep using their existing masked credential environment. */
export async function saveComposioCredential(value, options) {
  if (process.platform !== 'win32' || (options.provider && options.provider !== 'dpapi'))
    throw new Error('Headless hosts must use their protected credential environment.');
  if (typeof value !== 'string' || value.length < 8 || value.length > 2000 || /\s/u.test(value) || value.startsWith('ck_'))
    throw new Error('A Platform credential is required.');
  await protectBytes(Buffer.from(value), { ...options, purpose: 'composio-credential', provider: 'dpapi' });
}
export async function loadComposioCredential(options) {
  const value = (await unprotectBytes({ ...options, purpose: 'composio-credential' })).toString('utf8');
  if (value.length < 8 || value.length > 2000 || /\s/u.test(value) || value.startsWith('ck_'))
    throw new Error('Invalid protected Platform credential.');
  return value;
}

function publicRecipient(privateKey, workspace) {
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return { format: 'hive.key-recipient.v1', workspace, publicKey: der.toString('base64'), fingerprint: hash(der) };
}
export async function createKeyRecipient(options) {
  context(options.workspace, 'transfer-identity');
  let privateKey;
  try { privateKey = createPrivateKey({ key: await unprotectBytes({ ...options, purpose: 'transfer-identity' }), type: 'pkcs8', format: 'der' }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    privateKey = generateKeyPairSync('x25519').privateKey;
    await protectBytes(privateKey.export({ type: 'pkcs8', format: 'der' }), { ...options, purpose: 'transfer-identity' });
  }
  if (privateKey.asymmetricKeyType !== 'x25519') throw new Error('Unsupported recipient identity.');
  return publicRecipient(privateKey, options.workspace);
}

export function keyTransferFingerprint(packet) {
  const fields = ['format', 'workspace', 'recipientFingerprint', 'senderPublicKey', 'salt', 'iv', 'tag', 'data'];
  if (!packet || Object.keys(packet).length !== fields.length || fields.some(name => typeof packet[name] !== 'string' || packet[name].length > 16384))
    throw new Error('Invalid key transfer packet.');
  return hash(Buffer.from(JSON.stringify(Object.fromEntries(fields.sort().map(name => [name, packet[name]])))));
}

/** Pin the recipient fingerprint through the established trusted channel before sealing.
 * Only this encrypted envelope and public keys may go on Drive; private keys stay host protected. */
export function sealKeyTransfer(key, recipient, { expectedRecipientFingerprint } = {}) {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32 || recipient?.format !== 'hive.key-recipient.v1' || !validWorkspace(recipient.workspace)) throw new Error();
    if (!/^[a-f0-9]{64}$/u.test(expectedRecipientFingerprint ?? '') || recipient.fingerprint !== expectedRecipientFingerprint) throw new Error();
    const der = b64(recipient.publicKey);
    if (hash(der) !== recipient.fingerprint || der.length > 256) throw new Error();
    const target = createPublicKey({ key: der, type: 'spki', format: 'der' });
    if (target.asymmetricKeyType !== 'x25519') throw new Error();
    const sender = generateKeyPairSync('x25519'), senderPublic = sender.publicKey.export({ type: 'spki', format: 'der' });
    const salt = randomBytes(32), aad = Buffer.from(`hive.key-transfer.v1:${recipient.workspace}:${recipient.fingerprint}`);
    const wrapping = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: sender.privateKey, publicKey: target }), salt, aad, 32));
    return { format: 'hive.key-transfer.v1', workspace: recipient.workspace, recipientFingerprint: recipient.fingerprint,
      senderPublicKey: senderPublic.toString('base64'), salt: salt.toString('base64'), ...seal(key, wrapping, aad) };
  } catch { throw new Error('Invalid recipient or cloud key transfer.'); }
}
export async function receiveKeyTransfer(packet, { identityFile, file, workspace, provider, expectedTransferFingerprint }) {
  try {
    context(workspace, 'cloud-master');
    // Both fingerprints are pinned through the trusted orchestration channel, never learned from Drive alone.
    if (!/^[a-f0-9]{64}$/u.test(expectedTransferFingerprint ?? '') || keyTransferFingerprint(packet) !== expectedTransferFingerprint) throw new Error();
    if (packet?.format !== 'hive.key-transfer.v1' || packet.workspace !== workspace) throw new Error();
    const privateKey = createPrivateKey({ key: await unprotectBytes({ file: identityFile, workspace, purpose: 'transfer-identity' }), type: 'pkcs8', format: 'der' });
    if (publicRecipient(privateKey, workspace).fingerprint !== packet.recipientFingerprint) throw new Error();
    const sender = createPublicKey({ key: b64(packet.senderPublicKey), type: 'spki', format: 'der' });
    if (sender.asymmetricKeyType !== 'x25519') throw new Error();
    const aad = Buffer.from(`hive.key-transfer.v1:${workspace}:${packet.recipientFingerprint}`);
    const wrapping = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey: sender }), b64(packet.salt, 32), aad, 32));
    const key = open(packet, wrapping, aad);
    if (key.length !== 32) throw new Error();
    try {
      const existing = await loadCloudKey({ file, workspace });
      if (!timingSafeEqual(existing, key)) throw new Error();
      return { installed: true, existing: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await saveCloudKey(key, { file, workspace, provider });
      return { installed: true, existing: false };
    }
  } catch { throw new Error('Key transfer failed; existing protected material was preserved.'); }
}
