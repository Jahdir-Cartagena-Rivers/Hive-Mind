import fs from 'node:fs/promises';
import path from 'node:path';
import { createConnector, readConnection } from '../plugin/runtime.mjs';
import { startCloudHost } from '../scripts/cloud-host.mjs';

const isMutation = (name, args) => ['hive_mind_remember', 'hive_mind_forget', 'hive_mind_sync'].includes(name) ||
  (name === 'hive_mind_record' && ['save', 'forget', 'claim'].includes(args.action)) ||
  (['hive_mind_file', 'hive_mind_image'].includes(name) && args.action === 'import');
const errorReply = (id, text) => ({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } });

/** Host-started stdio connection; only the existing profile may be used. */
export async function createRemoteConnector({ profile, access = 'read', projects, includeGeneral = false }) {
  if (!path.isAbsolute(profile ?? '') || await fs.realpath(profile) !== path.resolve(profile))
    throw new Error('An existing absolute, unlinked Hive host profile is required.');
  if (!['read', 'write'].includes(access)) throw new Error('Choose read or write access explicitly.');
  const connectionFile = path.join(profile, 'connector-connection.json');
  // Validate scope options before a managed host can acquire profile ownership.
  const adapter = createConnector({ version: 1, access, connectionFile, ...(projects ? { projects, includeGeneral } : {}) });
  let host;
  async function request(route, body) {
    for (const file of [connectionFile, path.join(profile, 'service-token')]) {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid private connector binding.');
    }
    const connection = await readConnection({ connectionFile });
    // An installed desktop or another host's connection file must not be used.
    const expected = (await fs.readFile(path.join(profile, 'service-token'), 'utf8')).trim();
    if (connection.token !== expected || connection.url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(connection.url.hostname))
      throw new Error('Connector descriptor does not match this private host.');
    const response = await fetch(new URL(route, connection.url), { method: body === undefined ? 'GET' : 'POST',
      redirect: 'error', signal: AbortSignal.timeout(120000), headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Hive host operation rejected (HTTP ${response.status}).`);
    return response.json();
  }
  let current;
  try {
    const stat = await fs.lstat(connectionFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid private connector descriptor.');
    current = await request('/v1/status');
  } catch (error) {
    // Do not fall back to another brain or terminate a live existing owner.
    if (error.code !== 'ENOENT' && !/fetch failed|aborted|timeout/iu.test(error.message)) throw error;
    host = await startCloudHost({ profile, port: 0 });
    try { current = await request('/v1/status'); }
    catch (error) { await host.close(); throw error; }
  }
  if (!current.driveSync) { await host?.close(); throw new Error('Existing Hive host needs the connector coordinator update; preserve the profile.'); }
  async function handle(message) {
    const validRequest = message?.jsonrpc === '2.0' && message.id !== undefined &&
      (typeof message.id === 'string' || typeof message.id === 'number');
    if (validRequest && message.method === 'tools/call' && message.params?.name === 'hive_mind_cloud_sync') {
      const action = message.params?.arguments?.action;
      if (!['status', 'flush'].includes(action) || (action === 'flush' && access !== 'write'))
        return errorReply(message.id, 'Choose status, or flush with a writable connector.');
      try {
        const result = action === 'status' ? (await request('/v1/status')).driveSync : await request('/v1/cloud/flush', {});
        return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
      } catch { return errorReply(message.id, 'The selected host cannot report or flush Drive synchronization.'); }
    }
    if (validRequest && message.method === 'tools/list') {
      const reply = await adapter(message);
      if (reply.result?.tools) reply.result.tools.push({ name: 'hive_mind_cloud_sync',
        description: 'Inspect Drive synchronization or flush retained pending changes. After a locally committed write with uncertain shared sync, flush instead of resubmitting that write.',
        inputSchema: { type: 'object', properties: { action: { type: 'string', enum: access === 'write' ? ['status', 'flush'] : ['status'] } }, required: ['action'], additionalProperties: false },
        annotations: { readOnlyHint: access === 'read', destructiveHint: false } });
      return reply;
    }
    const mutation = message?.method === 'tools/call' && isMutation(message.params?.name, message.params?.arguments ?? {});
    // Delegate read-only rejection to the existing adapter without triggering sync.
    if (!mutation || access !== 'write' || !validRequest) return adapter(message);
    try {
      const before = await request('/v1/cloud/flush', {});
      if (before.state !== 'synced') return errorReply(message.id, JSON.stringify({
        localCommitted: false, driveConfirmed: false, state: before.state,
        ...(before.errorCode ? { errorCode: before.errorCode } : {}),
        message: 'Write not attempted: reconcile the existing Drive connection/conflict first.' }));
      const reply = await adapter(message);
      if (!reply.result || reply.result.isError || reply.error) return reply;
      let after;
      try { after = await request('/v1/cloud/flush', {}); }
      catch { after = { state: 'unknown' }; }
      const receipt = { localCommitted: true, driveConfirmed: after.state === 'synced', state: after.state,
        ...(after.state === 'synced' ? {} : { message: 'Saved locally; shared sync is pending or uncertain. Do not resubmit this write. Read current state and retry synchronization only.' }) };
      reply.result.content.push({ type: 'text', text: JSON.stringify({ hiveWriteReceipt: receipt }) });
      if (!receipt.driveConfirmed) reply.result.isError = true;
      return reply;
    } catch { return errorReply(message.id, 'Write was not started: the bound Hive host or sync coordinator is unavailable.'); }
  }
  return { handle, close: async () => host?.close(), ownsHost: Boolean(host) };
}
