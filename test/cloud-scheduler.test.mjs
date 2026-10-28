import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCloudScheduler, readDesktopCloudSettings, startDesktopCloudSync } from '../src/cloud-scheduler.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settings = directory => ({ version: 1, enabled: true, workspace: 'synthetic', client: 'desktop', bootstrap: 'join',
  protectedKeyFile: path.join(directory, 'master.protected.json'), transportOptions: { folderId: 'synthetic_folder', fileId: 'synthetic_file',
    expectedName: 'synthetic.enc', userId: 'synthetic-user', connectedAccountId: 'synthetic_account' } });
async function fixture(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-scheduler-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }

test('change bursts coalesce and cannot overlap a running worker', async () => {
  let calls = 0, concurrent = 0, maximum = 0, release;
  const manager = createCloudScheduler({ pollIntervalMs: 100000, minIntervalMs: 10, debounceMs: 2,
    run: async () => { calls++; concurrent++; maximum = Math.max(maximum, concurrent);
      if (calls === 1) await new Promise(resolve => { release = resolve; }); concurrent--; return { status: 'current' }; } });
  const first = manager.syncNow(); await delay(4);
  for (let i = 0; i < 10; i++) manager.changed();
  const same = manager.syncNow(); await delay(4); assert.equal(calls, 1);
  release(); await first; await same; await delay(25);
  assert.equal(maximum, 1); assert.equal(calls, 2); assert.equal(manager.status().state, 'synced');
  await manager.stop(); manager.changed(); await delay(10); assert.equal(calls, 2);
});

test('conflicts, pending erasure and provider failure have separate safe states', async () => {
  let result = { status: 'conflict' };
  const manager = createCloudScheduler({ pollIntervalMs: 100000, minIntervalMs: 1, debounceMs: 1,
    run: async () => { if (result instanceof Error) throw result; return result; } });
  await manager.syncNow(); assert.equal(manager.status().state, 'conflict');
  result = { status: 'current', historyErasure: { erased: false } }; await manager.syncNow();
  assert.equal(manager.status().state, 'cleanup-pending');
  result = Object.assign(new Error('must not expose private provider body'), { code: 'ERR_DRIVE_FILE_PROVIDER' }); await manager.syncNow();
  assert.equal(manager.status().state, 'offline'); assert.equal(JSON.stringify(manager.status()).includes('private provider'), false);
  result = { status: 'current' }; await manager.syncNow(); assert.equal(manager.status().state, 'synced'); await manager.stop();
});

test('private settings are opt-in and reject raw keys or executable adapter paths', async t => {
  const directory = await fixture(t), file = path.join(directory, 'drive-sync.json');
  assert.equal(await readDesktopCloudSettings(directory), null);
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: false })); assert.equal(await readDesktopCloudSettings(directory), null);
  const valid = settings(directory); await fs.writeFile(file, JSON.stringify(valid)); assert.deepEqual(await readDesktopCloudSettings(directory), valid);
  for (const change of [{ keyFile: '/plaintext' }, { transportModule: '/arbitrary.mjs' }, { protectedKeyFile: 'relative' },
    { pollIntervalMs: 1 }, { transportOptions: { ...valid.transportOptions, apiKey: 'must-not-be-configured-here' } }]) {
    await fs.writeFile(file, JSON.stringify({ ...valid, ...change })); await assert.rejects(readDesktopCloudSettings(directory));
  }
});

test('desktop worker uses fixed packaged code, private config references and a hidden process', async t => {
  const directory = await fixture(t), calls = [];
  const manager = startDesktopCloudSync({ settings: settings(directory), userData: directory, origin: 'http://127.0.0.1:1234',
    tokenFile: path.join(directory, 'service-token'), spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options }); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { setImmediate(() => child.emit('close', 1)); };
      setImmediate(() => { child.stdout.write(JSON.stringify({ status: 'current' })); child.emit('close', 0); }); return child;
    } });
  await manager.syncNow(); assert.equal(manager.status().state, 'synced'); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.windowsHide, true); assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[0].options.shell, undefined); assert.ok(calls[0].args[0].endsWith(path.join('scripts', 'cloud-sync-once.mjs')));
  const config = JSON.parse(await fs.readFile(calls[0].args[1], 'utf8'));
  assert.equal(config.storageMode, 'file'); assert.equal(config.keyFile, undefined); assert.equal(config.managedBy, 'hive-drive-worker-v1');
  assert.ok(config.keyProviderModule.endsWith(path.join('src', 'cloud-key.mjs'))); await manager.stop();
});
