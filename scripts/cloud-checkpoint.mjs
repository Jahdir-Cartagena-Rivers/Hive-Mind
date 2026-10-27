import fs from 'node:fs/promises';
import path from 'node:path';
import { CloudJournal } from '../src/cloud-journal.mjs';
import { DriveTransport } from '../src/drive-transport.mjs';
import { checkpointId, prepareCloudArchive, restoreCloudArchive } from '../src/cloud-archive.mjs';
import { validateCloudArchive } from '../src/cloud-archive.mjs';
import { cloudMergeBase, mergeCloudArchives } from '../src/cloud-merge.mjs';

// Explicit staging commands only. No automatic migration or installed-service reconfiguration.
const usage = 'Usage: node scripts/cloud-checkpoint.mjs <prepare|publish|inspect|restore|reconcile> <config.json>\nConfig: workspace, client, folderId, keyFile; prepare/restore/reconcile: stateDirectory, pendingFile; optional parent.\nDrive access token: protected process environment HIVE_MIND_DRIVE_ACCESS_TOKEN (not a CLI argument).';
try {
  const [command, configFile, ...extra] = process.argv.slice(2);
  if (!['prepare', 'publish', 'inspect', 'restore', 'reconcile'].includes(command) || !configFile || extra.length) throw new Error(usage);
  const config = JSON.parse(await fs.readFile(path.resolve(configFile), 'utf8'));
  if (!path.isAbsolute(config.keyFile ?? '')) throw new Error('keyFile must be an absolute protected path outside the Drive folder.');
  const keyStat = await fs.lstat(config.keyFile);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.size !== 32) throw new Error('Invalid protected key file.');
  const journal = new CloudJournal({ workspace: config.workspace, client: config.client,
    key: await fs.readFile(config.keyFile), transport: new DriveTransport({ folderId: config.folderId,
      token: async () => process.env.HIVE_MIND_DRIVE_ACCESS_TOKEN }) });
  if (['prepare', 'restore', 'reconcile'].includes(command) && !path.isAbsolute(config.stateDirectory ?? ''))
    throw new Error('stateDirectory must be an absolute dedicated staging path.');
  if (command !== 'inspect' && !path.isAbsolute(config.pendingFile ?? '')) throw new Error('pendingFile must be absolute.');
  let result;
  if (command === 'prepare') result = await prepareCloudArchive(config.stateDirectory, journal, config.pendingFile, config.parent ?? null);
  else if (command === 'inspect') {
    const state = await journal.inspect();
    result = { checkpoints: state.checkpoints.size, heads: state.heads, conflict: state.conflict };
  } else if (command === 'reconcile') {
    const state = await journal.inspect();
    const base = cloudMergeBase(state);
    const archives = [base, ...state.heads].map(id => state.checkpoints.get(id).archive);
    for (const archive of archives) await validateCloudArchive(archive, config.stateDirectory);
    const merged = mergeCloudArchives(...archives);
    if (merged.conflicts.length) {
      console.log(JSON.stringify({ conflict: true, conflicts: merged.conflicts }));
      process.exitCode = 2;
    } else {
      await validateCloudArchive(merged.archive, config.stateDirectory);
      const prepared = journal.encode(merged.archive, state.heads);
      await fs.writeFile(config.pendingFile, prepared.bytes, { flag: 'wx', mode: 0o600 });
      result = { id: prepared.id, parents: state.heads, conflict: false, published: false };
    }
  } else {
    const bytes = await fs.readFile(config.pendingFile);
    const id = checkpointId(bytes);
    result = command === 'publish' ? await journal.publish({ id, bytes })
      : await restoreCloudArchive(config.stateDirectory, journal, id, bytes);
  }
  if (result !== undefined) console.log(JSON.stringify(result));
} catch (error) {
  // Parsing errors can contain source excerpts; do not log arbitrary config/parser messages.
  console.error(error instanceof SyntaxError ? 'Invalid cloud config or checkpoint JSON.' : error.message);
  process.exitCode = 1;
}
