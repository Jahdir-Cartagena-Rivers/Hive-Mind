import fs from 'node:fs/promises';
import path from 'node:path';
import { BrainError, exportBrain, restoreBrain, persistBrainBytes } from './brain.mjs';
import { fingerprint } from './core/continuity.ts';
import { mutateHiveStore, readHiveMind, hashHiveForgetIdentity, isHiveMemoryForgotten } from './core/store.ts';

const memoryKey = memory => JSON.stringify([memory.scope, (memory.project ?? '').trim().toLocaleLowerCase(), memory.subject.trim().toLocaleLowerCase()]);

/** Snapshot assets and metadata under the existing owner mutation queue. */
export function liveCloudSnapshot(file) {
  return mutateHiveStore(file, async store => [store, { archive: await exportBrain(file), revision: fingerprint(store) }]);
}

/** Compare-and-apply a validated cloud merge while preserving local stream identity and new edits. */
export async function applyLiveCloudArchive(file, { archive, expectedRevision }) {
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedRevision))
    throw new BrainError(400, 'A current cloud snapshot revision is required.');
  const staging = await fs.mkdtemp(path.join(path.dirname(file), '.cloud-apply-'));
  let removedHashes = [];
  try {
    const temporary = path.join(staging, 'hive-mind.json');
    await restoreBrain(temporary, archive);
    await readHiveMind(temporary);
    // Retain original validated canonical revisions; restore changes only local consumption cursors.
    const incoming = archive.store;
    const result = await mutateHiveStore(file, async current => {
      if (fingerprint(current) !== expectedRevision)
        throw new BrainError(409, 'Local memory changed during cloud sync; merge again without overwriting it.');
      if (!current.continuity) throw new BrainError(409, 'Cloud apply requires an initialized service.');
      const incomingKeys = new Set(incoming.memories.map(memoryKey));
      if (incoming.memories.some(m => isHiveMemoryForgotten(incoming.forgotten ?? [], m) ||
          (incoming.forgottenMemoryIds ?? []).includes(m.id)) ||
          incoming.continuity.records.some(r => incoming.continuity.forgotten.includes(r.id)))
        throw new BrainError(409, 'Cloud snapshot would resurrect forgotten content.');
      for (const memory of current.memories)
        if (!incomingKeys.has(memoryKey(memory)) && !isHiveMemoryForgotten(incoming.forgotten ?? [], memory) &&
            !(incoming.forgottenMemoryIds ?? []).includes(memory.id))
          throw new BrainError(409, 'Cloud snapshot would remove memory without a forget marker.');
      for (const marker of current.forgotten ?? [])
        if (!(incoming.forgotten ?? []).some(next => hashHiveForgetIdentity(next) === hashHiveForgetIdentity(marker)) &&
            !incoming.memories.some(memory => isHiveMemoryForgotten([marker], memory)))
          throw new BrainError(409, 'Cloud snapshot would discard a memory forget marker.');
      for (const id of current.continuity.forgotten)
        if (!incoming.continuity.forgotten.includes(id))
          throw new BrainError(409, 'Cloud snapshot would discard a permanent forget marker.');
      for (const id of current.forgottenMemoryIds ?? [])
        if (!(incoming.forgottenMemoryIds ?? []).includes(id))
          throw new BrainError(409, 'Cloud snapshot would discard a permanent memory forget marker.');
      for (const record of current.continuity.records)
        if (!incoming.continuity.records.some(r => r.id === record.id) && !incoming.continuity.forgotten.includes(record.id))
          throw new BrainError(409, 'Cloud snapshot would remove a record without a forget marker.');
      for (const receipt of current.continuity.receipts)
        if (!incoming.continuity.receipts.some(r => r.key === receipt.key && fingerprint(r) === fingerprint(receipt)))
          throw new BrainError(409, 'Cloud snapshot would discard or change an existing retry receipt.');
      removedHashes = current.continuity.records.filter(r => r.kind === 'asset' &&
        !incoming.continuity.records.some(next => next.kind === 'asset' && next.data.hash === r.data.hash)).map(r => r.data.hash);
      for (const [hash, b64] of Object.entries(archive.images))
        await persistBrainBytes(file, hash, Buffer.from(b64, 'base64'));
      const records = incoming.continuity.records.map(record => record.kind === 'client' ? {
        ...record, history: [], data: { ...record.data, consumedSequence: 0,
          consumedStreamId: current.continuity.streamId, deliveredIds: [], usedIds: [] },
      } : record);
      const next = { ...incoming, continuity: { ...incoming.continuity, records,
        streamId: current.continuity.streamId, sequence: current.continuity.sequence, events: current.continuity.events } };
      return [next, { applied: true }];
    });
    try {
      await mutateHiveStore(file, async current => {
        for (const hash of new Set(removedHashes)) {
          if (current.continuity.records.some(r => r.kind === 'asset' && r.data.hash === hash)) continue;
          const target = path.join(path.dirname(file), 'visual-assets', hash);
          const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
          if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Invalid managed asset path.');
          if (stat) await fs.unlink(target);
        }
        return [current, undefined];
      });
    } catch { return { ...result, cleanupPending: true }; }
    return result;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
