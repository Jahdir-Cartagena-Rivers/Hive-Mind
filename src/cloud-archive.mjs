import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exportBrain, restoreBrain } from './brain.mjs';
import { readHiveMind } from './core/store.ts';
import { ownStateDirectory } from './ownership.mjs';
import { validateStateDirectory } from './service.mjs';

/** Validate the FULL archive with the production parser and asset/link checks, in an empty staging profile. */
export async function validateCloudArchive(archive, parentDirectory) {
  const staging = await fs.mkdtemp(path.join(parentDirectory, '.cloud-validate-'));
  try {
    const target = path.join(staging, 'hive-mind.json');
    await restoreBrain(target, archive);
    await readHiveMind(target);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** This staging exporter refuses a running service; use its authenticated export endpoint for a live snapshot. */
export async function prepareCloudArchive(directory, journal, pendingFile, parent = null) {
  await validateStateDirectory(directory);
  const release = await ownStateDirectory(directory);
  try {
    const source = path.join(directory, 'hive-mind.json');
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Cloud export requires an existing regular canonical store.');
    const archive = await exportBrain(source);
    await validateCloudArchive(archive, directory);
    const prepared = journal.encode(archive, parent);
    // The durable ciphertext is the retry identity; never regenerate it after an uncertain upload.
    await fs.writeFile(pendingFile, prepared.bytes, { flag: 'wx', mode: 0o600 });
    return { id: prepared.id, memories: archive.store.memories.length,
      records: archive.store.continuity.records.length, assets: Object.keys(archive.images).length };
  } finally {
    await release();
  }
}

/** Import is deliberately empty-target-only until multi-writer merge and retention are qualified. */
export async function restoreCloudArchive(directory, journal, id, bytes) {
  await validateStateDirectory(directory);
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Cloud restore requires a dedicated regular directory.');
  const release = await ownStateDirectory(directory);
  try {
    const { archive } = journal.decode(id, bytes);
    await validateCloudArchive(archive, directory);
    return await restoreBrain(path.join(directory, 'hive-mind.json'), archive);
  } finally {
    await release();
  }
}

export function checkpointId(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
