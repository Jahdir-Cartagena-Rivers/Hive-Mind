import { fingerprint, newContinuity } from './core/continuity.ts';
import { checkpointParents } from './cloud-journal.mjs';
import { hashHiveForgetIdentity, isHiveMemoryForgotten } from './core/store.ts';

const equal = (a, b) => a === undefined || b === undefined ? a === b : fingerprint(a) === fingerprint(b);
const identity = memory => JSON.stringify([memory.scope, (memory.project ?? '').trim().toLocaleLowerCase(), memory.subject.trim().toLocaleLowerCase()]);

/** A criss-cross or unrelated history must not select an arbitrary merge base. */
export function cloudMergeBase({ checkpoints, heads }) {
  if (heads.length !== 2) throw new Error('Reconciliation currently requires exactly two divergent heads.');
  const ancestors = start => {
    const seen = new Set(), pending = [start];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      const checkpoint = checkpoints.get(id);
      if (!checkpoint) throw new Error('Reconciliation has a missing ancestor.');
      seen.add(id); pending.push(...checkpointParents(checkpoint));
    }
    return seen;
  };
  const one = ancestors(heads[0]), two = ancestors(heads[1]);
  const common = [...one].filter(id => two.has(id));
  const older = new Set(common.flatMap(id => checkpointParents(checkpoints.get(id))));
  const closest = common.filter(id => !older.has(id));
  if (closest.length !== 1) throw new Error('No unique shared base; explicit migration reconciliation is required.');
  return closest[0];
}

/** Three-way merge of validated archives. Never chooses a winner for competing edits. */
export function mergeCloudArchives(base, left, right) {
  const conflicts = [];
  const mergeRows = (table, before, a, b, key, forbidden = () => false) => {
    const maps = [before, a, b].map(rows => {
      const map = new Map();
      for (const row of rows) {
        if (forbidden(row)) continue;
        const id = key(row);
        if (map.has(id)) throw new Error(`Duplicate ${table} identity in cloud archive.`);
        map.set(id, row);
      }
      return map;
    });
    const ids = [...new Set(maps.flatMap(map => [...map.keys()]))].sort();
    const merged = [];
    for (const id of ids) {
      const [old, one, two] = maps.map(map => map.get(id));
      const choice = equal(one, two) ? one : equal(one, old) ? two : equal(two, old) ? one : undefined;
      if (!equal(one, two) && !equal(one, old) && !equal(two, old)) {
        // Return IDs only. The unchanged input archives retain all conflicting versions.
        conflicts.push({ table, id });
      } else if (choice !== undefined) merged.push(choice);
    }
    return merged;
  };
  const mergeSet = (before, a, b) => [...new Set([...before, ...a, ...b])].filter(id => {
    const old = before.includes(id), one = a.includes(id), two = b.includes(id);
    return one === two ? one : one === old ? two : one;
  }).sort();
  for (const archive of [base, left, right])
    if (archive?.format !== 'hive-mind.archive.v1' || archive.store?.version !== 1 || !archive.store.continuity)
      throw new Error('Cloud merge requires three validated full archives.');
  const states = [base, left, right].map(a => a.store);
  const forgotten = mergeSet(...states.map(s => (s.forgotten ?? []).map(hashHiveForgetIdentity)));
  const forgottenMemoryIds = [...new Set(states.flatMap(s => s.forgottenMemoryIds ?? []))].sort();
  // Brain record IDs remain permanently forbidden by the existing store contract.
  const forgottenRecords = [...new Set(states.flatMap(s => s.continuity.forgotten))].sort();
  const memories = mergeRows('memory', ...states.map(s => s.memories), identity,
    m => forgottenMemoryIds.includes(m.id) || isHiveMemoryForgotten(forgotten, m));
  const records = mergeRows('record', ...states.map(s => s.continuity.records), r => r.id, r => forgottenRecords.includes(r.id));
  const receipts = mergeRows('receipt', ...states.map(s => s.continuity.receipts), r => r.key);
  // Distinct subjects must never accidentally acquire one UUID during a merge.
  if (new Set(memories.map(m => m.id)).size !== memories.length) conflicts.push({ table: 'memory', id: 'duplicate-id' });
  if (conflicts.length) return { archive: null, conflicts };
  const images = {};
  for (const record of records.filter(r => r.kind === 'asset')) {
    const candidates = [left, right, base].map(a => a.images[record.data.hash]).filter(v => v !== undefined);
    if (!candidates.length || candidates.some(v => v !== candidates[0]))
      throw new Error('Cloud merge has a missing or conflicting retained asset.');
    images[record.data.hash] = candidates[0];
  }
  return { archive: { format: 'hive-mind.archive.v1', store: { version: 1, memories, forgotten, forgottenMemoryIds,
    continuity: { ...newContinuity(), records, receipts, forgotten: forgottenRecords } }, images }, conflicts };
}
