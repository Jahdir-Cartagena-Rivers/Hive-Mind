import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CloudJournal } from '../src/cloud-journal.mjs';
import { CloudReplica } from '../src/cloud-replica.mjs';
import { DriveTransport } from '../src/drive-transport.mjs';
import { ChunkedTransport } from '../src/cloud-chunks.mjs';
import { CloudFileReplica } from '../src/cloud-file-replica.mjs';
import { loadComposioCredential } from '../src/cloud-key.mjs';

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
  const mode = config.storageMode ?? 'journal';
  if (!['journal', 'file'].includes(mode)) throw new Error('Unsupported cloud storage mode.');
  const origin = new URL(config.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Cloud sync local service must be HTTP loopback with no URL credentials.');
  if (config.composioCredentialFile) {
    const credential = await loadComposioCredential({ file: config.composioCredentialFile, workspace: config.workspace });
    if (process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_API_KEY !== credential)
      throw new Error('Protected credential source conflicts with the current host environment.');
    process.env.COMPOSIO_API_KEY = credential;
  }
  let key;
  if (config.keyProviderModule) {
    if (config.keyFile || !path.isAbsolute(config.keyProviderModule) || !config.keyProviderModule.endsWith('.mjs'))
      throw new Error('Select one explicit protected key source.');
    await protectedFile(config.keyProviderModule, 128 * 1024);
    const provider = await import(pathToFileURL(config.keyProviderModule).href);
    key = await provider.loadCloudKey({ ...config.keyProviderOptions, workspace: config.workspace });
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Protected cloud key is invalid.');
  } else key = await protectedFile(config.keyFile, 32);
  const token = (await protectedFile(config.tokenFile, 4096)).toString('utf8').trim();
  if (token.length < 32 || /\s/u.test(token)) throw new Error('Local service credential unavailable.');
  let transport;
  if (config.transportModule) {
    // Explicit reviewed code adapter only; never import a path obtained from memory or a remote checkpoint.
    if (!path.isAbsolute(config.transportModule) || !config.transportModule.endsWith('.mjs')) throw new Error('Transport adapter must be an absolute reviewed .mjs file.');
    await protectedFile(config.transportModule, 128 * 1024);
    const adapter = await import(pathToFileURL(config.transportModule).href);
    transport = mode === 'file' ? await adapter.createFileTransport(config.transportOptions ?? {})
      : await adapter.createTransport(config.transportOptions ?? {});
  } else {
    if (mode === 'file') throw new Error('File sync requires an explicit reviewed conditional transport.');
    transport = new DriveTransport({ folderId: config.folderId, token: async () => process.env.HIVE_MIND_DRIVE_ACCESS_TOKEN });
  }
  const request = async (route, body) => {
    const response = await fetch(origin.origin + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) { const error = new Error(`Local cloud operation rejected (HTTP ${response.status}).`); error.status = response.status; throw error; }
    return response.json();
  };
  const options = { directory: config.cacheDirectory, bootstrap: config.bootstrap,
    snapshot: () => request('/v1/cloud/snapshot', {}), apply: input => request('/v1/cloud/apply', input) };
  const replica = mode === 'file'
    ? new CloudFileReplica({ ...options, transport, key, workspace: config.workspace, client: config.client, binding: config.transportOptions })
    : new CloudReplica({ ...options, historyErasure: config.historyErasure ?? true,
      journal: new CloudJournal({ transport: new ChunkedTransport(transport), key, workspace: config.workspace, client: config.client }) });
  const result = await replica.syncOnce();
  console.log(JSON.stringify(result));
  if (result.status === 'conflict') process.exitCode = 2;
  else if (result.historyErasure?.erased === false) process.exitCode = 3;
  else if (result.status === 'retry') process.exitCode = 4;
} catch (error) {
  // No raw fetch/config/parser errors, request bodies, local paths or credentials in routine logs.
  console.error(JSON.stringify({ failed: true, status: error.status,
    ...(typeof error.code === 'string' && /^[A-Z_0-9]{1,80}$/u.test(error.code) ? { code: error.code } : {}),
    ...(typeof error.phase === 'string' && /^[a-z-]{1,50}$/u.test(error.phase) ? { phase: error.phase } : {}),
    ...(typeof error.logId === 'string' && /^log_[A-Za-z0-9_-]{1,100}$/u.test(error.logId) ? { logId: error.logId } : {}),
    message: 'Cloud sync did not complete; preserve the encrypted pending cache and inspect the protected configuration.' }));
  process.exitCode = 1;
}
