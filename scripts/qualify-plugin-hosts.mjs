// Native host checks without model turns, account login, or production data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { exportPlugin } from '../src/plugin-package.mjs';
import { createConnector } from '../plugin/runtime.mjs';
import { startHiveMind } from '../src/service.mjs';

process.env.HIVE_MIND_SEMANTIC = 'off';
const run = promisify(execFile);
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-native-plugin-'));
const token = randomBytes(32).toString('hex');
const service = await startHiveMind({ stateDirectory: path.join(evidence, 'state'), token, port: 0 });
const connectionFile = path.join(evidence, 'connection.json');
await fs.writeFile(connectionFile, JSON.stringify({ origin: service.origin, token }));
const destination = path.join(evidence, 'plugin');
await exportPlugin({ destination, connectionFile, access: 'write' });
const env = { ...process.env, CODEX_HOME: path.join(evidence, 'codex'),
  CLAUDE_CONFIG_DIR: path.join(evidence, 'claude'), HIVE_MIND_CONNECTION_FILE: connectionFile };
await fs.mkdir(env.CODEX_HOME); await fs.mkdir(env.CLAUDE_CONFIG_DIR);
const codex = process.platform === 'win32' ? process.execPath : 'codex';
const prefix = process.platform === 'win32' ? [path.join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js')] : [];
const claude = process.platform === 'win32' ? path.join(os.homedir(), '.local/bin/claude.exe') : 'claude';
const options = { env, cwd: evidence, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 };
const report = { evidence, modelTurns: 0 };
let child;
try {
  await run(codex, [...prefix, 'plugin', 'marketplace', 'add', destination, '--json'], options);
  const installed = await run(codex, [...prefix, 'plugin', 'add', 'hive-mind@hive-mind', '--json'], options);
  await fs.writeFile(path.join(evidence, 'codex-install.json'), installed.stdout);
  report.codexInstalled = true;
  const validation = await run(claude, ['plugin', 'validate', destination], options);
  await fs.writeFile(path.join(evidence, 'claude-validation.txt'), validation.stdout + validation.stderr);
  report.claudeManifest = /Validation passed/u.test(validation.stdout + validation.stderr);
  const health = await run(claude, ['--plugin-dir', destination, 'mcp', 'list'], options);
  await fs.writeFile(path.join(evidence, 'claude-health.txt'), health.stdout + health.stderr);
  report.claudeConnected = /hive-mind.*Connected/iu.test(health.stdout + health.stderr);
  if (!report.claudeConnected) throw new Error('Claude plugin did not connect. Inspect claude-health.txt.');
  child = spawn(codex, [...prefix, 'app-server'], { env, cwd: evidence, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0;
  child.stderr.on('data', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const done = pending.get(message.id); pending.delete(message.id);
      message.error ? done.reject(new Error(JSON.stringify(message.error))) : done.resolve(message.result);
    }
  });
  async function request(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native app-server timed out: ' + method)); }, 30000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  await request('initialize', { clientInfo: { name: 'hive-plugin-check', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const thread = await request('thread/start', { cwd: evidence, approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: true });
  const inventory = await request('mcpServerStatus/list', { threadId: thread.thread.id });
  const server = inventory.data.find(s => s.name.includes('hive-mind'));
  await fs.writeFile(path.join(evidence, 'codex-inventory.json'), JSON.stringify(inventory, null, 2));
  if (!server || !JSON.stringify(server.tools).includes('hive_mind_remember')) throw new Error('Codex did not discover plugin tools.');
  report.codexConnected = true;
  report.codexServer = server.name;
  const saved = await request('mcpServer/tool/call', { threadId: thread.thread.id, server: server.name, tool: 'hive_mind_remember',
    arguments: { scope: 'project', project: 'Nebula', subject: 'Native plugin canary', fact: 'Synthetic native client roundtrip.' } });
  await fs.writeFile(path.join(evidence, 'codex-tool-call.json'), JSON.stringify(saved, null, 2));
  const read = await createConnector({ version: 1, access: 'read', connectionFile })({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'hive_mind_recall', arguments: { query: 'Native plugin canary' } } });
  report.codexWriteReadBySecondClient = JSON.parse(read.result.content[0].text).memories.some(m => m.fact === 'Synthetic native client roundtrip.');
  if (!report.codexWriteReadBySecondClient) throw new Error('Native Codex write did not reach shared memory.');
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  child?.kill();
  await service.close();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
