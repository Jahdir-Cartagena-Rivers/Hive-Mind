import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 90 * 1024 * 1024;

/** Small immutable objects for transports with a 5 MiB upload limit. Only the final manifest commits a checkpoint. */
export class ChunkedTransport {
  constructor(transport, partBytes = 3 * 1024 * 1024) {
    if (!Number.isInteger(partBytes) || partBytes < 1 || partBytes > 4 * 1024 * 1024) throw new Error('Invalid cloud chunk limit.');
    this.transport = transport; this.partBytes = partBytes;
  }
  async list() { return this.transport.list(); }
  async read(id) {
    const raw = await this.transport.read(id);
    if (raw.length > MAX_BYTES) throw new Error('Cloud checkpoint exceeds the download limit.');
    let manifest;
    if (raw.length <= 128 * 1024) {
      try { manifest = JSON.parse(raw.toString('utf8')); } catch { /* Direct encrypted binary remains opaque. */ }
    }
    if (manifest?.format !== 'hive-cloud.chunks.v1') return raw;
    if (manifest.version !== 1 || !Number.isInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_BYTES ||
        !/^[a-f0-9]{64}$/u.test(manifest.sha256) || !Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 128)
      throw new Error('Invalid cloud chunk manifest.');
    const objects = await this.transport.list(), chunks = [], cache = new Map();
    let total = 0;
    for (const part of manifest.parts) {
      if (!part || !Number.isInteger(part.bytes) || part.bytes < 1 || part.bytes > 4 * 1024 * 1024 ||
          typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(part.sha256) || part.name !== `hive-part-${part.sha256}.blob`)
        throw new Error('Invalid cloud chunk reference.');
      total += part.bytes;
      if (total > manifest.bytes) throw new Error('Invalid cloud chunk total.');
      if (!cache.has(part.name)) {
        const candidates = objects.filter(object => object.name === part.name);
        if (!candidates.length) throw new Error('Cloud checkpoint has missing chunks; retry without changing local state.');
        let verified;
        for (const candidate of candidates) {
          const bytes = await this.transport.read(candidate.id);
          if (bytes.length !== part.bytes || hash(bytes) !== part.sha256) throw new Error('Cloud chunk integrity failed.');
          verified = bytes;
        }
        cache.set(part.name, verified);
      }
      const bytes = cache.get(part.name);
      if (bytes.length !== part.bytes) throw new Error('Conflicting cloud chunk lengths.');
      chunks.push(bytes);
    }
    if (total !== manifest.bytes) throw new Error('Incomplete cloud chunk total.');
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== manifest.sha256) throw new Error('Reassembled cloud checkpoint integrity failed.');
    return bytes;
  }
  async create(name, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw new Error('Invalid cloud checkpoint bytes.');
    if (bytes.length <= this.partBytes) return this.transport.create(name, bytes);
    if (Math.ceil(bytes.length / this.partBytes) > 128) throw new Error('Cloud checkpoint exceeds the part-count limit.');
    const objects = await this.transport.list(), parts = [];
    for (let offset = 0; offset < bytes.length; offset += this.partBytes) {
      const chunk = bytes.subarray(offset, offset + this.partBytes), sha256 = hash(chunk), partName = `hive-part-${sha256}.blob`;
      const candidates = objects.filter(object => object.name === partName);
      if (candidates.length) {
        for (const candidate of candidates) {
          const existing = await this.transport.read(candidate.id);
          if (existing.length !== chunk.length || hash(existing) !== sha256) throw new Error('Existing cloud chunk is corrupt.');
        }
      } else await this.transport.create(partName, chunk);
      parts.push({ name: partName, bytes: chunk.length, sha256 });
    }
    // If any part upload was uncertain, the caller retains original pending bytes. No manifest is committed yet.
    return this.transport.create(name, Buffer.from(JSON.stringify({ format: 'hive-cloud.chunks.v1', version: 1,
      bytes: bytes.length, sha256: hash(bytes), parts })));
  }
}
