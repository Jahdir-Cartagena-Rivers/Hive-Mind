import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CloudJournal } from './cloud-journal.mjs';
import { CloudReplica, archiveContentDigest } from './cloud-replica.mjs';
import { checkpointId, validateCloudArchive } from './cloud-archive.mjs';
import { mergeCloudArchives } from './cloud-merge.mjs';
import { collectCloudErasures, emptyErasures, redactCloudArchive } from './cloud-erasure.mjs';
import { fingerprint, newContinuity } from './core/continuity.ts';
import { ownStateDirectory } from './ownership.mjs';
import { validateStateDirectory } from './service.mjs';

const empty = () => ({ format: 'hive-mind.archive.v1', store: { version: 1, memories: [], continuity: newContinuity() }, images: {} });
const unique = ids => [...new Set(ids)];
const revision = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,2000}$/u.test(id);
const contentEqual = (a, b) => archiveContentDigest(a) === archiveContentDigest(b);

/** Conditional single-file sync. Drive revisions are backups, never the source of the current state. */
export class CloudFileReplica extends CloudReplica {
  constructor({ transport, key, workspace, client, binding, ...options }) {
    const codec = new CloudJournal({ key, workspace, client, transport: null });
    super({ ...options, journal: codec });
    if (!['read', 'write', 'purgeRevisions'].every(name => typeof transport?.[name] === 'function'))
      throw new Error('File sync requires conditional writes and exact revision deletion.');
    if (!binding || !['fileId', 'folderId', 'expectedName', 'connectedAccountId', 'userId'].every(name =>
      typeof binding[name] === 'string' && binding[name].length > 0 && binding[name].length <= 2000))
      throw new Error('File sync requires an explicit account, folder and exact file binding.');
    this.bindingDigest = fingerprint(Object.fromEntries(['fileId', 'folderId', 'expectedName', 'connectedAccountId', 'userId']
      .map(name => [name, binding[name]])));
    this.fileTransport = transport;
    // Never reinterpret a journal replica cache as a single-file binding.
    this.cache = path.join(this.directory, 'file-replica.checkpoint');
  }

  async save(state) { return super.save({ ...state, bindingDigest: this.bindingDigest }); }

  async readRemote(state) {
    const remote = await this.fileTransport.read(state?.baseEtag ? { etag: state.baseEtag } : undefined);
    if (typeof remote.etag !== 'string' || !remote.etag || remote.etag.length > 1000 || /[\r\n]/u.test(remote.etag) ||
        (remote.revisionId !== null && !revision(remote.revisionId))) throw new Error('Invalid conditional file metadata.');
    if (remote.unchanged) {
      if (!state?.base || !state.baseHead || state.baseEtag !== remote.etag || state.baseRevisionId !== remote.revisionId)
        throw new Error('Conditional read does not match the authenticated cached base.');
      return { ...remote, id: state.baseHead, archive: state.base, metadata: state.base.cloudFile };
    }
    if (remote.bytes === null) return { ...remote, id: null, archive: empty(), metadata: null };
    if (!Buffer.isBuffer(remote.bytes) || remote.revisionId === null) throw new Error('Invalid encrypted file body or missing head revision.');
    const id = checkpointId(remote.bytes), archive = this.journal.decode(id, remote.bytes).archive;
    const metadata = archive.cloudFile;
    if (metadata?.version !== 1 || typeof metadata.instanceId !== 'string' || !/^[a-f0-9-]{36}$/u.test(metadata.instanceId) ||
        !Array.isArray(metadata.priorRevisions) || metadata.priorRevisions.length > 10000 ||
        metadata.priorRevisions.some(id => !revision(id)) || typeof metadata.purgeAll !== 'boolean' ||
        !/^[a-f0-9]{64}$/u.test(metadata.erasureDigest)) throw new Error('Unsupported cloud file binding.');
    await validateCloudArchive(archive, this.directory);
    return { ...remote, id, archive, metadata };
  }

  async cleanup(state, remote) {
    const known = new Set(state.purgedRevisionIds ?? []);
    const wanted = remote.metadata.purgeAll ? remote.metadata.priorRevisions : remote.metadata.priorRevisions.slice(0, -3);
    const targets = wanted.filter(id => !known.has(id));
    if (!targets.length) return { state, ...(remote.metadata.purgeAll ? { historyErasure: { erased: true, pending: false } } : {}) };
    try {
      // The transport verifies this exact file binding and rejects its current head before each deletion.
      for (let start = 0; start < targets.length; start += 100) {
        const batch = targets.slice(start, start + 100);
        await this.fileTransport.purgeRevisions(batch);
        state = { ...state, purgedRevisionIds: unique([...(state.purgedRevisionIds ?? []), ...batch]) };
        await this.save(state);
      }
      return { state, ...(remote.metadata.purgeAll ? { historyErasure: { erased: true, pending: false } } : {}) };
    } catch {
      // Data may already be synced. Keep the encrypted remote purge inventory and report cleanup separately.
      return { state, ...(remote.metadata.purgeAll ? { historyErasure: { erased: false, pending: true } }
        : { retentionCleanupPending: true }) };
    }
  }

  async adoptRemoteErasures(state, remote) {
    const local = await this.snapshot();
    const rules = collectCloudErasures([remote.archive, local.archive, ...(state.base ? [state.base] : [])],
      emptyErasures(), [remote.archive]);
    if (!rules.memoryIds.length && !rules.recordIds.length) return { state, local };
    const clean = redactCloudArchive(local.archive, rules);
    if (!contentEqual(local.archive, clean)) await this.apply({ archive: clean, expectedRevision: local.revision });
    let pending = state.pending;
    if (pending) {
      const accepted = this.journal.decode(pending.id, Buffer.from(pending.bytes, 'base64')).archive;
      const sanitized = redactCloudArchive(accepted, rules);
      if (!contentEqual(accepted, sanitized)) {
        const packet = this.journal.encode(sanitized);
        pending = { ...pending, id: packet.id, bytes: packet.bytes.toString('base64'), needsRebase: true };
      }
      pending = { ...pending, localBefore: redactCloudArchive(pending.localBefore, rules),
        remoteBefore: redactCloudArchive(pending.remoteBefore, rules) };
    }
    const next = { ...state, pending, ...(state.base ? { base: redactCloudArchive(state.base, rules) } : {}) };
    await this.save(next);
    return { state: next, local: await this.snapshot(), rules };
  }

  async accept(state, remote) {
    const local = await this.snapshot();
    const rules = collectCloudErasures([state.pending.localBefore, local.archive, remote.archive], emptyErasures(), [remote.archive]);
    const merged = mergeCloudArchives(redactCloudArchive(state.pending.localBefore, rules),
      redactCloudArchive(local.archive, rules), remote.archive);
    if (merged.conflicts.length) return { status: 'conflict', conflicts: merged.conflicts, pending: state.pending.id };
    await validateCloudArchive(merged.archive, this.directory);
    if (!contentEqual(local.archive, merged.archive))
      await this.apply({ archive: merged.archive, expectedRevision: local.revision });
    const next = { ...state, baseHead: remote.id, base: remote.archive, baseEtag: remote.etag, baseRevisionId: remote.revisionId,
      instanceId: remote.metadata.instanceId, pending: null };
    await this.save(next);
    const { state: ignored, ...cleanup } = await this.cleanup(next, remote);
    return { status: 'synced', head: remote.id, ...cleanup };
  }

  async syncOnce() {
    await validateStateDirectory(this.directory);
    await fs.mkdir(this.directory, { recursive: true });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid file-sync cache directory.');
    const release = await ownStateDirectory(this.directory);
    try {
      let state = await this.load();
      if ((state.bindingDigest && state.bindingDigest !== this.bindingDigest) || (state.baseHead && !state.bindingDigest))
        throw new Error('File/account binding changed; preserve the cache and recover explicitly.');
      let remote = await this.readRemote(state);
      if (state.instanceId && remote.metadata && state.instanceId !== remote.metadata.instanceId)
        throw new Error('Canonical file identity changed; preserve local state and recover explicitly.');
      if (remote.id === null && (state.baseHead || this.bootstrap !== 'seed'))
        throw new Error('An empty dedicated cloud file requires explicit seed bootstrap.');
      if (!state.baseHead && !state.pending && remote.id) {
        const local = await this.snapshot();
        const rules = collectCloudErasures([remote.archive], emptyErasures(), [remote.archive]);
        if (this.bootstrap !== 'join' || (!contentEqual(local.archive, empty()) &&
            !contentEqual(local.archive, redactCloudArchive(empty(), rules))))
          throw new Error('Nonempty unbound local/cloud stores require explicit initial reconciliation.');
      }
      if (remote.metadata) {
        if (state.base && ((state.base.store.forgottenMemoryIds ?? []).some(id => !(remote.archive.store.forgottenMemoryIds ?? []).includes(id)) ||
            state.base.store.continuity.forgotten.some(id => !remote.archive.store.continuity.forgotten.includes(id))))
          throw new Error('Canonical file discarded permanent deletion markers; preserve local state.');
        ({ state } = await this.adoptRemoteErasures(state, remote));
      }
      if (state.pending) {
        const local = await this.snapshot();
        const accepted = this.journal.decode(state.pending.id, Buffer.from(state.pending.bytes, 'base64')).archive;
        const rules = collectCloudErasures([accepted, state.pending.localBefore, remote.archive, local.archive],
          emptyErasures(), [local.archive, remote.archive]);
        const cleanAccepted = redactCloudArchive(accepted, rules);
        if (!contentEqual(accepted, cleanAccepted) &&
            (remote.etag === state.pending.expectedEtag || remote.id === state.pending.id)) {
          const merged = mergeCloudArchives(redactCloudArchive(state.pending.localBefore, rules), local.archive, cleanAccepted);
          if (merged.conflicts.length) return { status: 'conflict', conflicts: merged.conflicts, pending: state.pending.id };
          await validateCloudArchive(merged.archive, this.directory);
          if (!contentEqual(local.archive, merged.archive)) await this.apply({ archive: merged.archive, expectedRevision: local.revision });
          state = { ...state, baseHead: remote.id, base: remote.id ? remote.archive : null,
            baseEtag: remote.id ? remote.etag : null, baseRevisionId: remote.id ? remote.revisionId : null, pending: null };
          await this.save(state);
        }
      }
      if (state.pending) {
        if (remote.id === state.pending.id) return await this.accept(state, remote);
        if (remote.etag !== state.pending.expectedEtag || state.pending.needsRebase) {
          const accepted = this.journal.decode(state.pending.id, Buffer.from(state.pending.bytes, 'base64')).archive;
          const local = await this.snapshot();
          const rules = collectCloudErasures([state.pending.remoteBefore, accepted, remote.archive, local.archive],
            emptyErasures(), [remote.archive, local.archive]);
          const carried = mergeCloudArchives(redactCloudArchive(state.pending.remoteBefore, rules),
            redactCloudArchive(accepted, rules), redactCloudArchive(remote.archive, rules));
          if (carried.conflicts.length) return { status: 'conflict', conflicts: carried.conflicts, pending: state.pending.id };
          const merged = mergeCloudArchives(redactCloudArchive(state.pending.localBefore, rules), local.archive, carried.archive);
          if (merged.conflicts.length) return { status: 'conflict', conflicts: merged.conflicts, pending: state.pending.id };
          await validateCloudArchive(merged.archive, this.directory);
          if (!contentEqual(local.archive, merged.archive)) await this.apply({ archive: merged.archive, expectedRevision: local.revision });
          state = { ...state, baseHead: remote.id, base: remote.archive, baseEtag: remote.etag, baseRevisionId: remote.revisionId, pending: null };
          await this.save(state);
        }
      }
      if (!state.pending) {
        const local = await this.snapshot();
        await validateCloudArchive(local.archive, this.directory);
        let merged;
        if (state.baseHead) merged = mergeCloudArchives(state.base, local.archive, remote.archive);
        else if (remote.id === null && this.bootstrap === 'seed') merged = { archive: local.archive, conflicts: [] };
        else if (this.bootstrap === 'join' && contentEqual(local.archive,
          redactCloudArchive(empty(), collectCloudErasures([remote.archive], emptyErasures(), [remote.archive]))))
          merged = { archive: remote.archive, conflicts: [] };
        else if (this.bootstrap === 'join' && contentEqual(local.archive, empty())) merged = { archive: remote.archive, conflicts: [] };
        else throw new Error('Nonempty unbound local/cloud stores require explicit initial reconciliation.');
        if (merged.conflicts.length) return { status: 'conflict', conflicts: merged.conflicts };
        const rules = collectCloudErasures([remote.archive, local.archive, ...(state.base ? [state.base] : [])], emptyErasures(), [merged.archive]);
        if (rules.memoryIds.length || rules.recordIds.length) merged.archive = redactCloudArchive(merged.archive, rules);
        if (remote.id && contentEqual(merged.archive, remote.archive)) {
          const applied = !contentEqual(local.archive, remote.archive);
          if (applied) await this.apply({ archive: remote.archive, expectedRevision: local.revision });
          state = { ...state, baseHead: remote.id, base: remote.archive, baseEtag: remote.etag, baseRevisionId: remote.revisionId,
            instanceId: remote.metadata.instanceId };
          await this.save(state);
          const { state: ignored, ...cleanup } = await this.cleanup(state, remote);
          return { status: applied ? 'synced' : 'current', head: remote.id, ...cleanup };
        }
        const purged = new Set(state.purgedRevisionIds ?? []);
        const metadata = { version: 1, instanceId: remote.metadata?.instanceId ?? state.instanceId ?? randomUUID(),
          priorRevisions: unique([...(remote.metadata?.priorRevisions ?? []), ...(remote.revisionId ? [remote.revisionId] : [])])
            .filter(id => !purged.has(id)), erasureDigest: fingerprint(rules),
          purgeAll: fingerprint(rules) !== (remote.metadata?.erasureDigest ?? fingerprint(emptyErasures())) ||
            Boolean(remote.metadata?.purgeAll && remote.metadata.priorRevisions.some(id => !purged.has(id))) };
        const prepared = this.journal.encode({ ...merged.archive, cloudFile: metadata });
        state = { ...state, instanceId: metadata.instanceId, pending: { id: prepared.id, bytes: prepared.bytes.toString('base64'),
          expectedEtag: remote.etag, localBefore: local.archive, remoteBefore: remote.archive } };
        // Persist exact ciphertext and its conditional revision before any upload begins.
        await this.save(state);
      }
      try { await this.fileTransport.write(Buffer.from(state.pending.bytes, 'base64'), { etag: state.pending.expectedEtag }); }
      catch (error) {
        if (error.status === 412 || error.code === 'CAS_CONFLICT') return { status: 'retry', reason: 'remote-changed', pending: state.pending.id };
        throw error;
      }
      remote = await this.readRemote();
      if (remote.id !== state.pending.id) return { status: 'retry', reason: 'remote-changed-after-write', pending: state.pending.id };
      return await this.accept(state, remote);
    } finally { await release(); }
  }
}
