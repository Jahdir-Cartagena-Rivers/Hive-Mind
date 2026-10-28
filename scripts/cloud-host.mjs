import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startHiveMind, validateStateDirectory } from '../src/service.mjs';
import { subscribeHiveChanges } from '../src/core/store.ts';
import { readDesktopCloudSettings, startDesktopCloudSync } from '../src/cloud-scheduler.mjs';

/** One local service and one coalesced sync worker, using only protected host configuration. */
export async function startCloudHost({ profile, port = 8788, onChange = () => {} }) {
  if (!path.isAbsolute(profile ?? '') || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('An absolute dedicated cloud profile and valid port are required.');
  if (await fs.realpath(profile) !== path.resolve(profile)) throw new Error('Resolve linked profile paths before launch.');
  const settings = await readDesktopCloudSettings(profile);
  if (!settings) throw new Error('Cloud host requires an enabled private configuration.');
  const stateDirectory = path.join(profile, 'data'); await validateStateDirectory(stateDirectory);
  const tokenFile = path.join(profile, 'service-token');
  try { await fs.writeFile(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(tokenFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid protected local token file.');
  const token = (await fs.readFile(tokenFile, 'utf8')).trim();
  if (token.length < 32 || /\s/u.test(token)) throw new Error('Invalid protected local token.');
  const service = await startHiveMind({ stateDirectory, token, port, cloudSyncEnabled: true });
  let manager, unsubscribe;
  try {
    manager = startDesktopCloudSync({ settings, userData: profile, origin: service.origin, tokenFile, onChange });
    unsubscribe = subscribeHiveChanges(path.join(stateDirectory, 'hive-mind.json'), () => manager.changed());
    let closing;
    return { origin: service.origin, status: () => manager.status(),
      close: () => closing ??= (async () => { unsubscribe?.(); await manager.stop(); await service.close(); })() };
  } catch (error) { await manager?.stop(); await service.close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [profile, port = '8788', ...extra] = process.argv.slice(2);
    if (extra.length || !/^\d{1,5}$/u.test(port)) throw new Error();
    const host = await startCloudHost({ profile, port: Number(port),
      onChange: status => console.log(JSON.stringify({ event: 'drive-sync', ...status })) });
    console.log(JSON.stringify({ event: 'ready', origin: host.origin }));
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void host.close().then(() => process.exit(0), () => process.exit(1)); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch { console.error(JSON.stringify({ failed: true, message: 'Cloud host could not start; preserve the profile and inspect private configuration.' })); process.exitCode = 1; }
}
