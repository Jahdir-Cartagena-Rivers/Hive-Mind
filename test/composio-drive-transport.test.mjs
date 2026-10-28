import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ComposioDriveTransport, createTransport, TOOL_VERSION } from '../src/composio-drive-transport.mjs';

const folder = 'synthetic_folder_12345', fileId = 'synthetic_file_12345';
const options = { apiKey: 'synthetic-project-key', userId: 'synthetic-user', connectedAccountId: 'synthetic_account_123' };
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const success = data => Response.json({ successful: true, data });

test('requires explicit bindings, rejects consumer keys early and restricts tool execution', async () => {
  assert.throws(() => new ComposioDriveTransport({ apiKey: 'synthetic-project' }), /Explicit/);
  assert.throws(() => new ComposioDriveTransport({ ...options, apiKey: 'ck_synthetic-consumer' }), /consumer keys/);
  assert.throws(() => createTransport({}), /folder/);
  const transport = new ComposioDriveTransport({ ...options, fetchImpl: () => assert.fail('no request expected') });
  await assert.rejects(transport.execute('GMAIL_SEND_EMAIL', {}), /Unsupported/);
});

test('pins tool version and account and fully paginates only exact-folder results', async () => {
  const calls = [];
  const transport = new ComposioDriveTransport({ ...options, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(body.version, TOOL_VERSION); assert.equal(body.user_id, options.userId);
    assert.equal(body.connected_account_id, options.connectedAccountId);
    return success({ files: [{ id: calls.length === 1 ? fileId : 'synthetic_second_123', name: 'fixture', parents: [folder] }],
      ...(calls.length === 1 ? { nextPageToken: 'opaque+/=' } : {}) });
  } });
  assert.equal((await transport.list(folder)).length, 2);
  assert.equal(calls[1].arguments.pageToken, 'opaque+/=');
  transport.fetch = async () => success({ files: [{ id: fileId, name: 'wrong parent', parents: ['different_folder'] }] });
  await assert.rejects(transport.list(folder), /outside/);
  transport.fetch = async () => success({ files: null });
  await assert.rejects(transport.list(folder), /malformed/);
});

test('reads only bounded native bytes, verifies integrity and never sends the project key to storage', async () => {
  const bytes = Buffer.from('synthetic encrypted bytes');
  const transport = new ComposioDriveTransport({ ...options, fetchImpl: async (url, init) => {
    const address = String(url);
    if (address.endsWith('GOOGLEDRIVE_GET_FILE_METADATA')) return success({ id: fileId, size: String(bytes.length), md5Checksum: md5(bytes), parents: [folder] });
    if (address.endsWith('GOOGLEDRIVE_DOWNLOAD_FILE')) return success({ downloaded_file_content: { s3url: 'https://synthetic.s3.amazonaws.com/fixture?signature=synthetic' } });
    assert.equal(init.headers, undefined);
    return new Response(bytes);
  } });
  assert.deepEqual(await transport.read(fileId, { folderId: folder }), bytes);
  await assert.rejects(transport.read(fileId, { folderId: 'different_folder' }), /outside/);
  transport.fetch = async () => success({ id: fileId, size: String(6 * 1024 * 1024), md5Checksum: md5(bytes), parents: [folder] });
  await assert.rejects(transport.read(fileId), /bounds/);
});

test('provider error bodies and signed URLs never enter error messages', async () => {
  const transport = new ComposioDriveTransport({ ...options, fetchImpl: async () => Response.json({ successful: false,
    error: 'synthetic-project-key https://private.invalid/?signature=secret' }) });
  await assert.rejects(transport.metadata(fileId), error => !error.message.includes('synthetic-project-key') && !error.message.includes('signature'));
});

test('create verifies the exact destination, stages bytes without auth forwarding and uploads once', async () => {
  const bytes = Buffer.from('synthetic payload'), name = 'fixture.bin'; let uploads = 0, storagePuts = 0;
  const transport = new ComposioDriveTransport({ ...options, fetchImpl: async (url, init) => {
    const address = String(url);
    if (address.includes('synthetic.s3.amazonaws.com')) {
      storagePuts++; assert.equal(init.headers['x-api-key'], undefined); assert.deepEqual(init.body, bytes); return new Response();
    }
    const body = JSON.parse(init.body);
    if (address.endsWith('GOOGLEDRIVE_GET_FILE_METADATA')) return body.arguments.fileId === folder
      ? success({ id: folder, mimeType: 'application/vnd.google-apps.folder' })
      : success({ id: fileId, name, parents: [folder], md5Checksum: md5(bytes), size: String(bytes.length) });
    if (address.endsWith('GOOGLEDRIVE_FIND_FILE')) return success({ files: [] });
    if (address.endsWith('/files/upload/request')) return Response.json({ key: 'synthetic-staging-key', type: 'new', new_presigned_url: 'https://synthetic.s3.amazonaws.com/upload?signature=synthetic' });
    if (address.endsWith('GOOGLEDRIVE_UPLOAD_FILE')) { uploads++; return success({ id: fileId }); }
    assert.fail('unexpected request');
  } });
  assert.equal((await transport.create(folder, name, bytes)).id, fileId);
  assert.equal(uploads, 1); assert.equal(storagePuts, 1);
});

test('an uncertain upload is not replayed when a post-check cannot see it', async () => {
  const bytes = Buffer.from('synthetic'), name = 'fixture.bin'; let uploads = 0;
  const transport = new ComposioDriveTransport({ ...options, retries: 2, fetchImpl: async (url, init) => {
    const address = String(url);
    if (address.endsWith('GOOGLEDRIVE_GET_FILE_METADATA')) return success({ id: folder, mimeType: 'application/vnd.google-apps.folder' });
    if (address.endsWith('GOOGLEDRIVE_FIND_FILE')) return success({ files: [] });
    if (address.endsWith('/files/upload/request')) return Response.json({ key: 'existing-staging-key', type: 'existing' });
    if (address.endsWith('GOOGLEDRIVE_UPLOAD_FILE')) { uploads++; return new Response('provider private details', { status: 503 }); }
    assert.fail('unexpected request');
  } });
  await assert.rejects(transport.create(folder, name, bytes), /Uncertain/);
  assert.equal(uploads, 1);
});

test('unexpected storage hosts reject before uploading any bytes', async () => {
  const bytes = Buffer.from('synthetic'); let egress = false;
  const transport = new ComposioDriveTransport({ ...options, fetchImpl: async (url, init) => {
    const address = String(url);
    if (address.endsWith('GOOGLEDRIVE_GET_FILE_METADATA')) return success({ id: folder, mimeType: 'application/vnd.google-apps.folder' });
    if (address.endsWith('GOOGLEDRIVE_FIND_FILE')) return success({ files: [] });
    if (address.endsWith('/files/upload/request')) return Response.json({ key: 'synthetic-staging', new_presigned_url: 'https://unrelated.invalid/upload' });
    egress = true; assert.fail('unexpected storage request');
  } });
  await assert.rejects(transport.create(folder, 'fixture.bin', bytes), /Unrecognized/);
  assert.equal(egress, false);
});

test('permanent deletion verifies the exact managed blob and refuses folders, renamed or foreign targets', async () => {
  const name = `hive-${'a'.repeat(64)}.checkpoint`; let deletes = 0;
  let meta = { id: fileId, name, parents: [folder], mimeType: 'application/octet-stream' };
  const transport = new ComposioDriveTransport({ ...options, retries: 2, fetchImpl: async (url, init) => {
    const address = String(url), body = JSON.parse(init.body);
    if (address.endsWith('GOOGLEDRIVE_GET_FILE_METADATA')) return success(meta);
    if (address.endsWith('GOOGLEDRIVE_GOOGLE_DRIVE_DELETE_FOLDER_OR_FILE_ACTION')) {
      deletes++; assert.deepEqual(body.arguments, { fileId, supportsAllDrives: false }); return success({});
    }
    if (address.endsWith('GOOGLEDRIVE_FIND_FILE')) return success({ files: [] });
    assert.fail('unexpected request');
  } });
  await transport.remove(folder, fileId, name); assert.equal(deletes, 1);
  for (const change of [{ parents: ['foreign_folder'] }, { name: 'changed.bin' },
    { mimeType: 'application/vnd.google-apps.folder' }, { id: folder }]) {
    meta = { id: fileId, name, parents: [folder], mimeType: 'application/octet-stream', ...change };
    await assert.rejects(transport.remove(folder, fileId, name), /outside|identity changed/);
  }
  assert.equal(deletes, 1);
  meta = { id: fileId, name, parents: [folder] };
  transport.fetch = async (url) => {
    if (String(url).endsWith('GOOGLEDRIVE_GET_FILE_METADATA')) return success(meta);
    deletes++; return new Response('private provider body', { status: 503 });
  };
  await assert.rejects(transport.remove(folder, fileId, name), /503/);
  assert.equal(deletes, 2, 'uncertain DELETE must not be blindly replayed');
});
