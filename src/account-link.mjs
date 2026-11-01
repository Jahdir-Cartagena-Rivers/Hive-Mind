// Server-side Composio sessions. Credentials and provider responses never reach the UI.
const BASE = 'https://backend.composio.dev';
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_:@.\/-]{1,200}$/u.test(v);
const safeError = (status) => new Error(`Account connection request failed${status ? ` (HTTP ${status})` : ''}.`);

export function createAccountLinkClient({ credential, callbackUrl, fetchImpl = fetch }) {
  if (typeof credential !== 'function') throw new Error('A server-owned credential loader is required.');
  if (callbackUrl) {
    const url = new URL(callbackUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
      throw new Error('The configured callback must be a clean HTTPS URL.');
  }
  async function api(route, body) {
    const key = await credential();
    if (typeof key !== 'string' || key.length < 8 || /\s/u.test(key) || key.startsWith('ck_'))
      throw new Error('A protected Composio Platform credential is required.');
    let response;
    try {
      response = await fetchImpl(BASE + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-api-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000), redirect: 'error' });
    } catch { throw safeError(); }
    if (!response.ok) { await response.body?.cancel(); throw safeError(response.status); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) throw safeError();
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw safeError(); }
  }
  async function verify(userId, accountId) {
    if (!identifier(userId) || !identifier(accountId)) throw new Error('Invalid server-owned account binding.');
    const account = await api('/api/v3/connected_accounts/' + encodeURIComponent(accountId));
    if (account.id !== accountId || account.user_id !== userId || account.toolkit?.slug !== 'googledrive')
      throw new Error('Connected account does not belong to this user and Drive binding.');
    if (account.status !== 'ACTIVE' || account.is_disabled === true)
      throw new Error('Google Drive authorization is not active.');
    return { accountId, toolkit: 'googledrive', active: true };
  }
  return {
    verify,
    async verifyDrive({ userId, accountId }) {
      const binding = await verify(userId, accountId);
      const result = await api('/api/v3/tools/execute/proxy', { user_id: userId, connected_account_id: accountId,
        endpoint: 'https://www.googleapis.com/drive/v3/about', method: 'GET',
        parameters: [{ name: 'fields', type: 'query', value: 'user(permissionId)' }] });
      if (result.status !== 200 || typeof result.data?.user?.permissionId !== 'string')
        throw new Error('Google Drive could not verify the selected account.');
      return { ...binding, providerVerified: true,
        ...(identifier(result.log_id) ? { logId: result.log_id } : {}) };
    },
    async createSession({ userId, accountId }) {
      if (!identifier(userId)) throw new Error('An authenticated server-owned user ID is required.');
      if (accountId) await verify(userId, accountId);
      const session = await api('/api/v3.1/tool_router/session', { user_id: userId,
        toolkits: { enable: ['googledrive'] },
        ...(accountId ? { connected_accounts: { googledrive: [accountId] } } : {}) });
      if (!identifier(session.session_id)) throw safeError();
      // Do not return session.mcp or any other credential-bearing upstream fields.
      return { userId, sessionId: session.session_id, ...(accountId ? { accountId } : {}) };
    },
    async begin(attempt) {
      if (!identifier(attempt?.sessionId) || !identifier(attempt?.userId)) throw new Error('Invalid connection attempt.');
      // Reuse an explicit valid account instead of silently initiating reauthorization.
      if (attempt.accountId) return { status: 'connected', ...await verify(attempt.userId, attempt.accountId) };
      if (!callbackUrl) throw new Error('Hosted account callback has not been configured.');
      const link = await api(`/api/v3.1/tool_router/session/${encodeURIComponent(attempt.sessionId)}/link`, {
        toolkit: 'googledrive', callback_url: callbackUrl });
      let redirect;
      try { redirect = new URL(link.redirect_url); } catch { throw safeError(); }
      if (redirect.protocol !== 'https:' || redirect.username || redirect.password ||
          !['connect.composio.dev', 'backend.composio.dev', 'composio.link'].includes(redirect.hostname) ||
          !identifier(link.connected_account_id)) throw safeError();
      return { status: 'pending', accountId: link.connected_account_id, redirectUrl: redirect.href };
    },
    async complete({ attempt, authenticatedUserId, callbackAccountId }) {
      // attempt must be read from protected server-side storage, never from a callback body.
      if (!attempt || attempt.userId !== authenticatedUserId || attempt.accountId !== callbackAccountId ||
          !Number.isSafeInteger(attempt.expiresAt) || attempt.expiresAt <= Date.now())
        throw new Error('Account callback is expired or does not match the signed-in user and stored attempt.');
      return verify(attempt.userId, attempt.accountId);
    },
  };
}
