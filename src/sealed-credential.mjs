import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const FORMAT = 'hive.sealed-credential.v1';
const name = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(value);
const workspaceName = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value);
function binding({ key, workspace, credential, owner }) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !workspaceName(workspace) || !name(credential) ||
      typeof owner !== 'string' || !owner.trim() || owner.length > 2000) throw new Error('Invalid sealed credential binding.');
  const ownerHash = createHash('sha256').update(owner.trim().toLowerCase()).digest('hex');
  const fields = { format: FORMAT, workspace, credential, ownerHash };
  const aad = Buffer.from(JSON.stringify(fields));
  return { fields, aad, wrapping: Buffer.from(hkdfSync('sha256', key, Buffer.from(workspace), Buffer.from(`hive-credential-v1:${ownerHash}:${credential}`), 32)) };
}
/** Only the returned encrypted bytes may become a retained Hive file asset. */
export function sealCredential(value, options) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096) throw new Error('Invalid credential value.');
  const { fields, aad, wrapping } = binding(options), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', wrapping, iv); cipher.setAAD(aad);
    const data = Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()]);
    return Buffer.from(JSON.stringify({ ...fields, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  } finally { wrapping.fill(0); }
}
/** Decrypt only inside the consuming application's private process pipe. Never expose through memory recall. */
export function openCredential(bytes, options) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > 16384) throw new Error();
    const packet = JSON.parse(bytes.toString('utf8')), { fields, aad, wrapping } = binding(options);
    try {
      if (Object.keys(packet).length !== 7 || Object.entries(fields).some(([k, v]) => packet[k] !== v) ||
          !['iv','tag','data'].every(k => typeof packet[k] === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(packet[k]))) throw new Error();
      const iv = Buffer.from(packet.iv, 'base64'), tag = Buffer.from(packet.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', wrapping, iv); decipher.setAAD(aad); decipher.setAuthTag(tag);
      const value = Buffer.concat([decipher.update(Buffer.from(packet.data,'base64')),decipher.final()]);
      if (!value.length || value.length > 4096) throw new Error();
      return value.toString('utf8');
    } finally { wrapping.fill(0); }
  } catch { throw new Error('Sealed credential could not be opened for this account.'); }
}
