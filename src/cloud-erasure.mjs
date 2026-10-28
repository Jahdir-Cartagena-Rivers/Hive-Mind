import { fingerprint } from './core/continuity.ts';
import { hashHiveForgetIdentity, hiveForgetMarker } from './core/store.ts';

const unique = values => [...new Set(values)].sort();
export const emptyErasures = () => ({ memoryIds: [], recordIds: [] });
export function validateErasures(rules) {
  if (!rules || !['memoryIds', 'recordIds'].every(key => Array.isArray(rules[key]) &&
      rules[key].length <= 100000 && rules[key].every(id => typeof id === 'string' && id.length > 0 && id.length <= 4000)) ||
      Object.keys(rules).some(key => !['memoryIds', 'recordIds'].includes(key)))
    throw new Error('Invalid cloud erasure markers.');
  return { memoryIds: unique(rules.memoryIds), recordIds: unique(rules.recordIds) };
}
export const unionErasures = (...rules) => validateErasures({
  memoryIds: rules.flatMap(rule => validateErasures(rule).memoryIds),
  recordIds: rules.flatMap(rule => validateErasures(rule).recordIds),
});

/** Convert observed tombstones to permanent content-free IDs, across every retained revision. */
export function collectCloudErasures(archives, previous = emptyErasures(), activeArchives = archives) {
  // Only current resolved tombstones select legacy IDs. Old tombstones must not erase an explicit later re-remember.
  const markers = new Set(activeArchives.flatMap(a => a.store.forgotten ?? []).map(hashHiveForgetIdentity));
  const records = new Set([...previous.recordIds, ...activeArchives.flatMap(a => a.store.continuity.forgotten)]);
  // A relation removed by an existing forget may exist only in an older checkpoint.
  let changed;
  do {
    changed = false;
    for (const archive of archives) for (const row of archive.store.continuity.records)
      if (row.kind === 'relation' && [row.data.from, row.data.to].some(id => records.has(id)) && !records.has(row.id)) {
        records.add(row.id); changed = true;
      }
  } while (changed);
  return validateErasures({ memoryIds: [...previous.memoryIds, ...activeArchives.flatMap(a => a.store.forgottenMemoryIds ?? []),
    ...archives.flatMap(a => a.store.memories.filter(m => markers.has(hiveForgetMarker(m))).map(m => m.id))],
    recordIds: [...records] });
}

/** Pure, deterministic redaction. Independent copies of the same fact are separate memories. */
export function redactCloudArchive(archive, rules) {
  rules = validateErasures(rules);
  const out = structuredClone(archive), memoryIds = new Set(rules.memoryIds), ids = new Set(rules.recordIds);
  const removedMemories = out.store.memories.filter(row => memoryIds.has(row.id));
  out.store.memories = out.store.memories.filter(row => !memoryIds.has(row.id));
  out.store.forgottenMemoryIds = unique([...(out.store.forgottenMemoryIds ?? []), ...memoryIds]);
  out.store.forgotten = unique([...(out.store.forgotten ?? []).map(hashHiveForgetIdentity),
    ...removedMemories.map(hiveForgetMarker)]);
  const state = out.store.continuity;
  const purge = data => {
    const next = structuredClone(data);
    for (const key of ['assetIds', 'referenceIds', 'deliveredIds', 'usedIds'])
      if (Array.isArray(next[key])) next[key] = next[key].filter(id => !ids.has(id));
    if (ids.has(next.taskId)) delete next.taskId;
    if (Array.isArray(next.annotations)) next.annotations = next.annotations.filter(row => !ids.has(row.assetId));
    return next;
  };
  state.records = state.records.filter(row => !ids.has(row.id)).map(row => {
    const data = purge(row.data), history = row.history.map(entry => {
      const data = purge(entry.data);
      return fingerprint(data) === fingerprint(entry.data) ? entry : { ...entry, data, redacted: true };
    });
    if (fingerprint([data, history]) === fingerprint([row.data, row.history])) return row;
    // No wall clock: every client must produce identical sanitized checkpoint content.
    const next = { ...row, data, history };
    const { history: ignored, revision: oldRevision, ...summary } = next;
    return { ...next, revision: fingerprint({ ...summary, data, history }) };
  });
  state.forgotten = unique([...state.forgotten, ...ids]);
  // Receipts contain only retry identity/digest, never the erased body. Preserve them to prevent replays.
  const retainedHashes = new Set(state.records.filter(row => row.kind === 'asset').map(row => row.data.hash));
  out.images = Object.fromEntries(Object.entries(out.images).filter(([hash]) => retainedHashes.has(hash)));
  return out;
}
