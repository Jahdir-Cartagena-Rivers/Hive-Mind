import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import { fingerprint } from './core/continuity.ts';
import { emptyErasures, validateErasures, unionErasures, redactCloudArchive } from './cloud-erasure.mjs';

const MAX_BYTES = 90 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/u;
const validName = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value);
export const checkpointParents = checkpoint => checkpoint.version === 1
  ? checkpoint.parent === null ? [] : [checkpoint.parent] : checkpoint.parents;

/** Immutable encrypted checkpoint journal. Divergence is an explicit conflict, never last-write-wins. */
export class CloudJournal {
  constructor({ transport, key, workspace, client }) {
    if (!Buffer.isBuffer(key) || key.length !== 32 || !validName(workspace) || !validName(client))
      throw new Error('Cloud sync requires a 32-byte key and bounded workspace/client identifiers.');
    this.transport = transport;
    this.key = key;
    this.workspace = workspace;
    this.client = client;
  }

  encode(archive, parent = null, redaction = null) {
    const parents = Array.isArray(parent) ? [...parent].sort() : parent === null ? [] : [parent];
    if (parents.length > 8 || new Set(parents).size !== parents.length || parents.some(p => typeof p !== 'string' || !digest.test(p)))
      throw new Error('Invalid checkpoint parent.');
    if (redaction && !digest.test(redaction)) throw new Error('Invalid redacted checkpoint identity.');
    const payload = Buffer.from(JSON.stringify({ version: redaction ? 3 : 2, workspace: this.workspace,
      client: this.client, parents, archive, ...(redaction ? { redaction } : {}) }));
    if (payload.length > 64 * 1024 * 1024) throw new Error('Cloud checkpoint exceeds 64 MiB.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`hive-cloud-v1:${this.workspace}`));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const bytes = Buffer.from(JSON.stringify({ version: 1, iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') }));
    return { id: hash(bytes), bytes };
  }

  decode(id, bytes) {
    try {
      if (!digest.test(id) || bytes.length > MAX_BYTES || hash(bytes) !== id) throw new Error();
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (envelope.version !== 1 || !['iv', 'tag', 'data'].every(k => typeof envelope[k] === 'string'))
        throw new Error();
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(`hive-cloud-v1:${this.workspace}`));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      if (plain.length > 64 * 1024 * 1024) throw new Error();
      const checkpoint = JSON.parse(plain.toString('utf8'));
      if (![1, 2, 3].includes(checkpoint.version) || checkpoint.workspace !== this.workspace ||
          !validName(checkpoint.client) ||
          checkpoint.archive?.format !== 'hive-mind.archive.v1') throw new Error();
      if (checkpoint.version === 3 && (!digest.test(checkpoint.redaction) || checkpoint.redaction === id)) throw new Error();
      const parents = checkpointParents(checkpoint);
      if (!Array.isArray(parents) || parents.length > 8 || new Set(parents).size !== parents.length ||
          parents.some(p => typeof p !== 'string' || !digest.test(p))) throw new Error();
      return checkpoint;
    } catch {
      throw new Error('Cloud checkpoint authentication or format failed; local data was preserved.');
    }
  }

  async inspect() {
    // Names are content addresses, not a uniqueness constraint provided by Drive.
    const objects = await this.transport.list();
    if (objects.length > 10000) throw new Error('Cloud journal exceeds the checkpoint limit.');
    const checkpoints = new Map();
    const candidates = [], markers = [];
    let downloadedBytes = 0;
    for (const object of objects) {
      const match = /^hive-([a-f0-9]{64})\.(checkpoint|erasure)$/u.exec(object.name);
      if (!match) continue;
      const id = match[1];
      // Read every duplicate: a same-name corrupt object is not silently ignored.
      const bytes = await this.transport.read(object.id);
      downloadedBytes += bytes.length;
      if (downloadedBytes > 256 * 1024 * 1024) throw new Error('Cloud journal exceeds the staging replay budget.');
      const checkpoint = this.decode(id, bytes);
      if (match[2] === 'erasure') {
        if (checkpoint.version !== 2 || checkpoint.parents.length ||
            Object.keys(checkpoint.archive).sort().join(',') !== 'erasures,format')
          throw new Error('Invalid cloud erasure envelope.');
        markers.push(validateErasures(checkpoint.archive.erasures));
      } else candidates.push({ object, id, checkpoint });
    }
    const erasures = unionErasures(emptyErasures(), ...markers);
    for (const { id, checkpoint } of candidates) {
      const logicalId = checkpoint.version === 3 ? checkpoint.redaction : id;
      const archive = erasures.memoryIds.length || erasures.recordIds.length
        ? redactCloudArchive(checkpoint.archive, erasures) : checkpoint.archive;
      const previous = checkpoints.get(logicalId);
      if (previous && (fingerprint(previous.archive) !== fingerprint(archive) ||
          fingerprint(checkpointParents(previous)) !== fingerprint(checkpointParents(checkpoint))))
        throw new Error('Conflicting redacted checkpoint ancestry or content.');
      checkpoints.set(logicalId, { ...checkpoint, archive });
    }
    for (const checkpoint of checkpoints.values())
      if (checkpointParents(checkpoint).some(parent => !checkpoints.has(parent)))
        throw new Error('Cloud journal has a missing ancestor; retry without changing local data.');
    const parents = new Set([...checkpoints.values()].flatMap(checkpointParents));
    const heads = [...checkpoints.keys()].filter(id => !parents.has(id)).sort();
    if (checkpoints.size && heads.length === 0) throw new Error('Invalid cloud checkpoint graph.');
    // A parent digest is authenticated, but enforce reachability independently of assumptions about hashes.
    const visited = new Set();
    const visit = (id, chain) => {
      if (chain.has(id)) throw new Error('Invalid cloud checkpoint cycle.');
      if (visited.has(id)) return;
      const next = new Set(chain); next.add(id);
      for (const parent of checkpointParents(checkpoints.get(id))) visit(parent, next);
      visited.add(id);
    };
    for (const head of heads) visit(head, new Set());
    if (visited.size !== checkpoints.size) throw new Error('Unreachable cloud checkpoint history.');
    return { checkpoints, heads, conflict: heads.length > 1, erasures, candidates, objects };
  }

  async publish(prepared) {
    // Caller persists prepared bytes before starting a network write, making uncertain retries identical.
    const checkpoint = this.decode(prepared.id, prepared.bytes);
    const before = await this.inspect();
    if ((before.erasures.memoryIds.length || before.erasures.recordIds.length) &&
        fingerprint(redactCloudArchive(checkpoint.archive, before.erasures)) !== fingerprint(checkpoint.archive))
      throw new Error('Pending checkpoint contains erased content; sanitize local state before retrying.');
    if (before.checkpoints.has(prepared.id)) return { id: prepared.id, existing: true, conflict: before.conflict };
    const expected = [...checkpointParents(checkpoint)].sort();
    if (JSON.stringify(before.heads) !== JSON.stringify(expected))
      throw new Error('Cloud head changed; retain the pending checkpoint and reconcile before publishing.');
    await this.transport.create(`hive-${prepared.id}.checkpoint`, prepared.bytes);
    const after = await this.inspect();
    if (!after.checkpoints.has(prepared.id)) throw new Error('Cloud write is not visible yet; retry the same pending bytes.');
    // Two clients can pass the preflight simultaneously. Both branches survive and are reported.
    return { id: prepared.id, existing: false, conflict: after.conflict };
  }

  /** Persist a durable forget marker before rewriting any retained object. Safe to retry after interruption. */
  async eraseHistory(rules) {
    rules = validateErasures(rules);
    if (!rules.memoryIds.length && !rules.recordIds.length) return { erased: true, removed: 0 };
    if (typeof this.transport.remove !== 'function')
      throw new Error('Cloud history erasure requires a folder-scoped permanent-delete transport.');
    let current = await this.inspect();
    const combined = unionErasures(current.erasures, rules);
    if (fingerprint(combined) !== fingerprint(current.erasures)) {
      const marker = this.encode({ format: 'hive-mind.archive.v1', erasures: combined });
      await this.transport.create(`hive-${marker.id}.erasure`, marker.bytes);
      current = await this.inspect();
      if (fingerprint(current.erasures) !== fingerprint(combined))
        throw new Error('Concurrent erasure changed the marker set; retry without deleting history.');
    }
    let removed = 0;
    for (const candidate of current.candidates) {
      const logicalId = candidate.checkpoint.version === 3 ? candidate.checkpoint.redaction : candidate.id;
      const sanitized = current.checkpoints.get(logicalId);
      // Also replace an old alias if a later forget removed more of its content.
      if (fingerprint(candidate.checkpoint.archive) === fingerprint(sanitized.archive)) continue;
      // Authentication alone does not prove that all retained records, links and asset bytes remain usable.
      const { validateCloudArchive } = await import('./cloud-archive.mjs');
      await validateCloudArchive(sanitized.archive, os.tmpdir());
      const replacement = this.encode(sanitized.archive, checkpointParents(sanitized), logicalId);
      await this.transport.create(`hive-${replacement.id}.checkpoint`, replacement.bytes);
      const verified = await this.inspect();
      if (!verified.candidates.some(row => row.id === replacement.id) ||
          fingerprint(verified.checkpoints.get(logicalId)?.archive) !== fingerprint(sanitized.archive))
        throw new Error('Redacted replacement could not be verified; original history remains.');
      // The adapter verifies the exact parent folder and object name. Never trash or overwrite.
      await this.transport.remove(candidate.object.id, candidate.object.name);
      removed++;
    }
    const after = await this.inspect();
    const orphanParts = typeof this.transport.erasureAudit === 'function' ? (await this.transport.erasureAudit()).orphanParts : 0;
    const pending = orphanParts > 0 || after.candidates.some(row => fingerprint(row.checkpoint.archive) !==
      fingerprint(after.checkpoints.get(row.checkpoint.version === 3 ? row.checkpoint.redaction : row.id).archive));
    return { erased: !pending, removed, pending, orphanParts };
  }
}
