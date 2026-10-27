import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprint, newContinuity } from './core/continuity.ts';
import { writeAtomic } from './core/files.ts';
import { checkpointId, validateCloudArchive } from './cloud-archive.mjs';
import { cloudMergeBase, mergeCloudArchives } from './cloud-merge.mjs';
import { ownStateDirectory } from './ownership.mjs';
import { validateStateDirectory } from './service.mjs';

const emptyArchive = () => ({ format: 'hive-mind.archive.v1', store: { version: 1, memories: [], continuity: newContinuity() }, images: {} });
const sorted = (rows, key) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
export const archiveContentDigest = archive => fingerprint({
  memories: sorted(archive.store.memories, r => r.id), forgotten: [...(archive.store.forgotten ?? [])].sort(),
  records: sorted(archive.store.continuity.records, r => r.id),
  receipts: sorted(archive.store.continuity.receipts, r => r.key),
  forgottenRecords: [...archive.store.continuity.forgotten].sort(), images: archive.images,
});

/** One resumable cycle. snapshot/apply are authenticated local service callbacks, never filesystem replacements. */
export class CloudReplica {
  constructor({ journal, directory, snapshot, apply, bootstrap }) {
    if (!path.isAbsolute(directory) || !['seed', 'join', 'resume'].includes(bootstrap))
      throw new Error('Cloud replica requires a dedicated absolute cache and explicit bootstrap direction.');
    Object.assign(this, { journal, directory, snapshot, apply, bootstrap });
    this.cache = path.join(directory, 'replica.checkpoint');
  }

  async save(state) {
    // Local base/pending state contains memory too. Encrypt it with the same protected key.
    const packet = this.journal.encode({ format: 'hive-mind.archive.v1', replica: state });
    await writeAtomic(this.cache, packet.bytes.toString('utf8'));
  }

  async load() {
    try {
      const stat = await fs.lstat(this.cache);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 90 * 1024 * 1024) throw new Error();
      const bytes = await fs.readFile(this.cache);
      const packet = this.journal.decode(checkpointId(bytes), bytes);
      const state = packet.archive.replica;
      if (packet.client !== this.journal.client || state?.version !== 1 || !('baseHead' in state) || !('pending' in state)) throw new Error();
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, baseHead: null, base: null, pending: null };
      throw new Error('Replica cache is invalid; preserve it and recover explicitly.');
    }
  }

  async syncOnce() {
    await validateStateDirectory(this.directory);
    await fs.mkdir(this.directory, { recursive: true });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid replica cache directory.');
    const release = await ownStateDirectory(this.directory);
    try {
      const state = await this.load();
      if (state.pending) return await this.finish(state);
      const local = await this.snapshot();
      await validateCloudArchive(local.archive, this.directory);
      const remote = await this.journal.inspect();
      let remoteArchive, parents = remote.heads;
      if (!parents.length) {
        if (state.baseHead || this.bootstrap !== 'seed') throw new Error('Empty remote store requires explicit seed bootstrap.');
        remoteArchive = emptyArchive();
      } else if (parents.length === 1) remoteArchive = remote.checkpoints.get(parents[0]).archive;
      else {
        const baseId = cloudMergeBase(remote);
        const merged = mergeCloudArchives(remote.checkpoints.get(baseId).archive,
          ...parents.map(id => remote.checkpoints.get(id).archive));
        if (merged.conflicts.length) return { status: 'conflict', conflicts: merged.conflicts };
        remoteArchive = merged.archive;
      }
      await validateCloudArchive(remoteArchive, this.directory);
      let merged;
      if (state.baseHead) {
        if (!remote.checkpoints.has(state.baseHead)) throw new Error('Cloud base disappeared; preserve local state and recover explicitly.');
        merged = mergeCloudArchives(state.base, local.archive, remoteArchive);
      } else if (!parents.length && this.bootstrap === 'seed') merged = { archive: local.archive, conflicts: [] };
      else if (this.bootstrap === 'join' && archiveContentDigest(local.archive) === archiveContentDigest(emptyArchive()))
        merged = { archive: remoteArchive, conflicts: [] };
      else throw new Error('Nonempty local/cloud stores require explicit initial reconciliation.');
      if (merged.conflicts.length) return { status: 'conflict', conflicts: merged.conflicts };
      await validateCloudArchive(merged.archive, this.directory);
      if (parents.length === 1 && archiveContentDigest(local.archive) === archiveContentDigest(remoteArchive)) {
        await this.save({ ...state, baseHead: parents[0], base: remoteArchive });
        return { status: 'current', head: parents[0] };
      }
      const prepared = this.journal.encode(merged.archive, parents);
      const pending = { id: prepared.id, bytes: prepared.bytes.toString('base64'), localBefore: local.archive };
      // This write must precede the network operation. A timeout never regenerates the pending upload.
      await this.save({ ...state, pending });
      return await this.finish({ ...state, pending });
    } finally { await release(); }
  }

  async finish(state) {
    const pending = state.pending;
    const bytes = Buffer.from(pending.bytes, 'base64');
    const accepted = this.journal.decode(pending.id, bytes).archive;
    const result = await this.journal.publish({ id: pending.id, bytes });
    // If another writer won the network race, retain this transaction until a deliberate merge.
    if (result.conflict) return { status: 'conflict', pending: pending.id };
    const current = await this.snapshot();
    const merged = mergeCloudArchives(pending.localBefore, current.archive, accepted);
    if (merged.conflicts.length) return { status: 'conflict', conflicts: merged.conflicts, pending: pending.id };
    await validateCloudArchive(merged.archive, this.directory);
    if (archiveContentDigest(current.archive) !== archiveContentDigest(merged.archive))
      await this.apply({ archive: merged.archive, expectedRevision: current.revision });
    await this.save({ version: 1, baseHead: pending.id, base: accepted, pending: null });
    return { status: 'synced', head: pending.id };
  }
}
