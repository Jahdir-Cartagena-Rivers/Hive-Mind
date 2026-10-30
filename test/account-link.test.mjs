import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountLinkClient } from '../src/account-link.mjs';

const userId = 'synthetic-user', accountId = 'ca_synthetic';
const account = { id: accountId, user_id: userId, toolkit: { slug: 'googledrive' }, status: 'ACTIVE' };
const callbackUrl = 'https://hive.example.test/account/callback';
function fixture(responses) {
  const calls = [];
  const client = createAccountLinkClient({ credential: async () => 'synthetic-platform-key', callbackUrl,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : undefined });
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-api-key'], 'synthetic-platform-key');
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return new Response(JSON.stringify(value?.body ?? value), { status: value?.httpStatus ?? 200 });
    } });
  return { client, calls };
}
test('existing explicit account is verified and pinned to a Drive-only session without reconnecting', async () => {
  const f = fixture([account, { session_id: 'trs_synthetic', mcp: { url: 'private-token-must-not-escape' } }, account]);
  const session = await f.client.createSession({ userId, accountId });
  assert.deepEqual(session, { userId, accountId, sessionId: 'trs_synthetic' });
  assert.deepEqual(f.calls[1].body, { user_id: userId, toolkits: { enable: ['googledrive'] }, connected_accounts: { googledrive: [accountId] } });
  assert.equal((await f.client.begin(session)).status, 'connected');
  assert.ok(!f.calls.some(c => c.url.endsWith('/link')));
});
test('managed connect link uses configured callback and exposes only the expected pending fields', async () => {
  const f = fixture([{ session_id: 'trs_synthetic' }, { redirect_url: 'https://connect.composio.dev/link/synthetic', connected_account_id: accountId, secret: 'do-not-return' }]);
  const session = await f.client.createSession({ userId });
  const pending = await f.client.begin(session);
  assert.deepEqual(Object.keys(pending).sort(), ['accountId', 'redirectUrl', 'status']);
  assert.equal(f.calls[1].body.callback_url, callbackUrl);
});
test('callback rejects switched users/accounts, expiry, revoked authorization and other providers', async () => {
  const attempt = { userId, accountId, expiresAt: Date.now() + 10000 };
  const f = fixture([account]);
  for (const value of [
    { attempt, authenticatedUserId: 'other', callbackAccountId: accountId },
    { attempt, authenticatedUserId: userId, callbackAccountId: 'ca_other' },
    { attempt: { ...attempt, expiresAt: 0 }, authenticatedUserId: userId, callbackAccountId: accountId },
  ]) await assert.rejects(f.client.complete(value));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.client.complete({ attempt, authenticatedUserId: userId, callbackAccountId: accountId })).active, true);
  for (const value of [{ ...account, status: 'REVOKED' }, { ...account, is_disabled: true }, { ...account, user_id: 'other' }, { ...account, toolkit: { slug: 'gmail' } }])
    await assert.rejects(fixture([value]).client.verify(userId, accountId));
});
test('provider errors and malicious redirects never leak response bodies or credentials', async () => {
  for (const response of [new Error('secret upstream failure'), { httpStatus: 403, body: { token: 'private' } }]) {
    await assert.rejects(fixture([response]).client.verify(userId, accountId), error => !/private|secret|synthetic-platform-key/.test(error.message));
  }
  await assert.rejects(fixture([{ connected_account_id: accountId, redirect_url: 'https://attacker.example/link' }]).client.begin({ userId, sessionId: 'trs_synthetic' }));
  assert.throws(() => createAccountLinkClient({ credential: async () => '', callbackUrl: 'http://public.example/callback' }));
});
test('Drive probe verifies selected native account before a read-only provider request', async () => {
  const f = fixture([account, { status: 200, data: { user: { permissionId: 'synthetic-provider-identity' } }, log_id: 'log_synthetic' }]);
  assert.deepEqual(await f.client.verifyDrive({ userId, accountId }), { accountId, toolkit: 'googledrive', active: true, providerVerified: true, logId: 'log_synthetic' });
  assert.equal(f.calls[1].body.method, 'GET');
  assert.equal(f.calls[1].body.connected_account_id, accountId);
  await assert.rejects(fixture([account, { status: 403, data: {} }]).client.verifyDrive({ userId, accountId }));
});
