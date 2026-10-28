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
  async erasureAudit() {
    const objects = await this.transport.list(), referenced = new Set();
    for (const object of objects.filter(row => /^hive-[a-f0-9]{64}\.(?:checkpoint|erasure)$/u.test(row.name))) {
      const raw = await this.transport.read(object.id);
      let manifest;
      try { manifest = raw.length <= 128 * 1024 ? JSON.parse(raw.toString('utf8')) : null; } catch { continue; }
      if (manifest?.format === 'hive-cloud.chunks.v1') {
        await this.read(object.id);
        for (const part of manifest.parts) referenced.add(part.name);
      }
    }
    // An interrupted upload/deletion can leave parts whose owner is unknown. Never delete an in-flight writer's parts.
    return { orphanParts: objects.filter(row => /^hive-part-[a-f0-9]{64}\.blob$/u.test(row.name) && !referenced.has(row.name)).length };
  }
  async remove(id, name) {
    if (typeof this.transport.remove !== 'function') throw new Error('Cloud transport cannot permanently delete retained history.');
    const raw = await this.transport.read(id);
    let manifest;
    try { manifest = raw.length <= 128 * 1024 ? JSON.parse(raw.toString('utf8')) : null; } catch { /* encrypted */ }
    // Validate the complete checkpoint before removing the manifest or any part.
    await this.read(id);
    await this.transport.remove(id, name);
    if (manifest?.format !== 'hive-cloud.chunks.v1') return;
    const objects = await this.transport.list(), retained = new Set();
    for (const object of objects.filter(row => /^hive-[a-f0-9]{64}\.(?:checkpoint|erasure)$/u.test(row.name))) {
      const bytes = await this.transport.read(object.id);
      let other;
      try { other = bytes.length <= 128 * 1024 ? JSON.parse(bytes.toString('utf8')) : null; } catch { continue; }
      if (other?.format === 'hive-cloud.chunks.v1') {
        if (!Array.isArray(other.parts)) throw new Error('Malformed retained manifest; chunk cleanup stopped.');
        for (const part of other.parts) retained.add(part.name);
      }
    }
    for (const part of manifest.parts) if (!retained.has(part.name))
      for (const object of objects.filter(row => row.name === part.name))
        await this.transport.remove(object.id, object.name);
  }
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
