import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameReplacing } from './core/files.ts';

const safeCode = value => typeof value === 'string' && /^[A-Z_0-9]{1,80}$/u.test(value) ? value : undefined;
const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Coalesce local changes and periodic pulls; never run two workers for one client. */
export function createCloudScheduler({ run, onChange = () => {}, pollIntervalMs = 300000, minIntervalMs = 30000, debounceMs = 2000 }) {
  if (typeof run !== 'function' || [pollIntervalMs, minIntervalMs, debounceMs].some(n => !Number.isInteger(n) || n < 1))
    throw new Error('Invalid cloud scheduling options.');
  let stopped = false, active = null, controller, timer, pending = false, lastStarted = 0;
  let state = { enabled: true, state: 'pending', lastSuccessAt: null };
  const emit = next => { state = { ...state, ...next }; onChange({ ...state }); };
  const schedule = delay => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; void syncNow(false); }, delay);
    timer.unref?.();
  };
  async function syncNow(manual = true) {
    if (stopped) return { ...state };
    pending = true;
    if (active) return active;
    const wait = Math.max(0, minIntervalMs - (Date.now() - lastStarted));
    if (!manual && wait) { schedule(wait); return { ...state }; }
    if (timer) { clearTimeout(timer); timer = null; }
    pending = false; lastStarted = Date.now(); controller = new AbortController();
    emit({ state: 'syncing', errorCode: undefined });
    active = Promise.resolve().then(() => run(controller.signal)).then(result => {
      if (stopped) return state;
      const outcome = result?.status === 'conflict' ? 'conflict'
        : result?.historyErasure?.erased === false ? 'cleanup-pending'
        : result?.status === 'retry' ? 'pending' : ['synced', 'current'].includes(result?.status) ? 'synced' : 'offline';
      emit({ state: outcome, ...(outcome === 'synced' ? { lastSuccessAt: new Date().toISOString() } : {}) });
      return { ...state };
    }).catch(error => {
      if (!stopped) emit({ state: 'offline', errorCode: safeCode(error.code) });
      return { ...state };
    }).finally(() => {
      active = null;
      if (pending) schedule(Math.max(1, minIntervalMs - (Date.now() - lastStarted)));
    });
    return active;
  }
  const poll = setInterval(() => { void syncNow(false); }, pollIntervalMs); poll.unref?.();
  schedule(1);
  return { status: () => ({ ...state }), syncNow,
    changed() { if (stopped) return; pending = true; if (!active) emit({ state: 'pending' }); schedule(debounceMs); },
    async stop() {
      stopped = true; pending = false; clearTimeout(timer); clearInterval(poll); controller?.abort();
      if (active) await active;
      state = { ...state, state: 'stopped' };
    } };
}

/** Opt-in host configuration only. It is never imported from a memory or a cloud archive. */
export async function readDesktopCloudSettings(userData) {
  const file = path.join(userData, 'drive-sync.json');
  const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid private cloud configuration.');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  const allowed = ['version', 'enabled', 'workspace', 'client', 'bootstrap', 'protectedKeyFile', 'composioCredentialFile', 'transportOptions', 'pollIntervalMs'];
  if (value?.version !== 1 || typeof value.enabled !== 'boolean' || Object.keys(value).some(k => !allowed.includes(k)))
    throw new Error('Unsupported private cloud configuration.');
  if (!value.enabled) return null;
  if (!['workspace', 'client'].every(k => typeof value[k] === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value[k])) ||
      !['seed', 'join', 'resume'].includes(value.bootstrap) || !path.isAbsolute(value.protectedKeyFile ?? '') ||
      (value.composioCredentialFile !== undefined && !path.isAbsolute(value.composioCredentialFile)) ||
      (value.pollIntervalMs !== undefined && (!Number.isInteger(value.pollIntervalMs) || value.pollIntervalMs < 30000 || value.pollIntervalMs > 86400000)))
    throw new Error('Invalid private cloud binding.');
  const keys = ['folderId', 'fileId', 'expectedName', 'userId', 'connectedAccountId'];
  if (!value.transportOptions || Object.keys(value.transportOptions).some(k => !keys.includes(k)) ||
      keys.some(k => typeof value.transportOptions[k] !== 'string' || !value.transportOptions[k] || value.transportOptions[k].length > 2000))
    throw new Error('Explicit cloud account and file binding are required.');
  return value;
}

async function runtimeConfiguration(userData, config) {
  const target = path.join(userData, 'drive-worker.json');
  const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 ||
      JSON.parse(await fs.readFile(target, 'utf8')).managedBy !== 'hive-drive-worker-v1'))
    throw new Error('Existing unmanaged cloud worker configuration was preserved.');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...config, managedBy: 'hive-drive-worker-v1' }), { flag: 'wx', mode: 0o600 });
    await renameReplacing(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
  return target;
}

/** Run the packaged, fixed worker entrypoint. No executable code paths or secrets come from Drive. */
export function startDesktopCloudSync({ settings, userData, origin, tokenFile, onChange, executable = process.execPath, spawnImpl = spawn }) {
  const config = { storageMode: 'file', workspace: settings.workspace, client: settings.client, bootstrap: settings.bootstrap,
    origin, tokenFile, cacheDirectory: path.join(userData, 'drive-cache'),
    keyProviderModule: path.join(SOURCE, 'src', 'cloud-key.mjs'), keyProviderOptions: { file: settings.protectedKeyFile },
    ...(settings.composioCredentialFile ? { composioCredentialFile: settings.composioCredentialFile } : {}),
    transportModule: path.join(SOURCE, 'src', 'composio-drive-file.mjs'), transportOptions: settings.transportOptions };
  return createCloudScheduler({ pollIntervalMs: settings.pollIntervalMs ?? 300000, onChange,
    run: async signal => {
      const file = await runtimeConfiguration(userData, config);
      if (signal.aborted) throw new Error('Cloud worker stopped.');
      return new Promise((resolve, reject) => {
        const child = spawnImpl(executable, [path.join(SOURCE, 'scripts', 'cloud-sync-once.mjs'), file],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [], stderr = []; let bytes = 0, settled = false;
        const finish = (error, result) => {
          if (settled) return; settled = true; clearTimeout(timeout); signal.removeEventListener('abort', stop);
          error ? reject(error) : resolve(result);
        };
        const stop = () => { child.kill(); finish(new Error('Cloud worker stopped.')); };
        const timeout = setTimeout(stop, 600000); timeout.unref?.(); signal.addEventListener('abort', stop, { once: true });
        const collect = list => chunk => {
          bytes += chunk.length;
          if (bytes > 65536) { child.kill(); finish(new Error('Cloud worker output exceeded its limit.')); } else list.push(chunk);
        };
        child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
        child.on('error', () => finish(new Error('Cloud worker could not start.')));
        child.on('close', code => {
          try {
            const output = Buffer.concat(stdout).toString('utf8').trim();
            const result = output ? JSON.parse(output) : null;
            if ([0, 2, 3, 4].includes(code) && result && typeof result.status === 'string') return finish(null, result);
            const detail = JSON.parse(Buffer.concat(stderr).toString('utf8').trim());
            const error = new Error('Cloud worker did not complete.'); error.code = safeCode(detail?.code); finish(error);
          } catch { finish(new Error('Cloud worker did not complete.')); }
        });
      });
    } });
}
