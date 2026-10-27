import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CloudJournal } from '../src/cloud-journal.mjs';
import { CloudReplica } from '../src/cloud-replica.mjs';
import { DriveTransport } from '../src/drive-transport.mjs';

async function protectedFile(file, maxBytes) {
  if (!path.isAbsolute(file ?? '')) throw new Error('Protected file paths must be absolute.');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Invalid protected file.');
  return fs.readFile(file);
}

try {
  const [configFile, ...extra] = process.argv.slice(2);
  if (!configFile || extra.length) throw new Error('Usage: node scripts/cloud-sync-once.mjs <private-config.json>');
  const config = JSON.parse((await protectedFile(path.resolve(configFile), 16384)).toString('utf8'));
  const origin = new URL(config.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Cloud sync local service must be HTTP loopback with no URL credentials.');
  const key = await protectedFile(config.keyFile, 32);
  const token = (await protectedFile(config.tokenFile, 4096)).toString('utf8').trim();
  if (token.length < 32 || /\s/u.test(token)) throw new Error('Local service credential unavailable.');
  let transport;
  if (config.transportModule) {
    // Explicit reviewed code adapter only; never import a path obtained from memory or a remote checkpoint.
    if (!path.isAbsolute(config.transportModule) || !config.transportModule.endsWith('.mjs')) throw new Error('Transport adapter must be an absolute reviewed .mjs file.');
    await protectedFile(config.transportModule, 128 * 1024);
    const adapter = await import(pathToFileURL(config.transportModule).href);
    transport = await adapter.createTransport(config.transportOptions ?? {});
  } else transport = new DriveTransport({ folderId: config.folderId, token: async () => process.env.HIVE_MIND_DRIVE_ACCESS_TOKEN });
  const journal = new CloudJournal({ transport, key, workspace: config.workspace, client: config.client });
  const request = async (route, body) => {
    const response = await fetch(origin.origin + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) { const error = new Error(`Local cloud operation rejected (HTTP ${response.status}).`); error.status = response.status; throw error; }
    return response.json();
  };
  const replica = new CloudReplica({ journal, directory: config.cacheDirectory, bootstrap: config.bootstrap,
    snapshot: () => request('/v1/cloud/snapshot', {}), apply: input => request('/v1/cloud/apply', input) });
  const result = await replica.syncOnce();
  console.log(JSON.stringify(result));
  if (result.status === 'conflict') process.exitCode = 2;
} catch (error) {
  // No raw fetch/config/parser errors, request bodies, local paths or credentials in routine logs.
  console.error(error.status ? `Cloud sync was rejected (HTTP ${error.status}); pending state is retained.`
    : 'Cloud sync did not complete; preserve the encrypted pending cache and inspect the protected configuration.');
  process.exitCode = 1;
}
