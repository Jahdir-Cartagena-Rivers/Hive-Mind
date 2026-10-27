import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

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

  encode(archive, parent = null) {
    const parents = Array.isArray(parent) ? [...parent].sort() : parent === null ? [] : [parent];
    if (parents.length > 8 || new Set(parents).size !== parents.length || parents.some(p => typeof p !== 'string' || !digest.test(p)))
      throw new Error('Invalid checkpoint parent.');
    const payload = Buffer.from(JSON.stringify({ version: 2, workspace: this.workspace,
      client: this.client, parents, archive }));
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
      if (![1, 2].includes(checkpoint.version) || checkpoint.workspace !== this.workspace ||
          !validName(checkpoint.client) ||
          checkpoint.archive?.format !== 'hive-mind.archive.v1') throw new Error();
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
    let downloadedBytes = 0;
    for (const object of objects) {
      if (!/^hive-[a-f0-9]{64}\.checkpoint$/u.test(object.name)) continue;
      const id = object.name.slice(5, -11);
      // Read every duplicate: a same-name corrupt object is not silently ignored.
      const bytes = await this.transport.read(object.id);
      downloadedBytes += bytes.length;
      if (downloadedBytes > 256 * 1024 * 1024) throw new Error('Cloud journal exceeds the staging replay budget.');
      const checkpoint = this.decode(id, bytes);
      checkpoints.set(id, checkpoint);
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
    return { checkpoints, heads, conflict: heads.length > 1 };
  }

  async publish(prepared) {
    // Caller persists prepared bytes before starting a network write, making uncertain retries identical.
    const checkpoint = this.decode(prepared.id, prepared.bytes);
    const before = await this.inspect();
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
}
