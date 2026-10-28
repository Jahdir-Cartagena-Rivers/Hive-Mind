/** Google Drive v3 transport; auth is injected so protected OAuth/Composio providers can be substituted. */
export class DriveTransport {
  constructor({ folderId, token, fetchImpl = fetch }) {
    if (typeof folderId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/u.test(folderId) || typeof token !== 'function')
      throw new Error('A Drive folder ID and protected token provider are required.');
    this.folderId = folderId;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(url, options = {}) {
    const token = await this.token();
    if (typeof token !== 'string' || !token || /\s/u.test(token)) throw new Error('Drive credential unavailable.');
    let response;
    try {
      response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: { ...options.headers, authorization: `Bearer ${token}` } });
    } catch {
      // URLs, provider error bodies and tokens must not reach application logs.
      throw new Error('Drive request interrupted; write outcome may be uncertain.');
    }
    if (!response.ok) throw new Error(`Drive request failed (HTTP ${response.status}); no automatic write replay.`);
    return response;
  }

  async list() {
    const files = [];
    const seen = new Set();
    let page;
    do {
      const query = new URLSearchParams({ q: `'${this.folderId}' in parents and trashed = false`,
        spaces: 'drive', corpora: 'user', pageSize: '1000', fields: 'nextPageToken,incompleteSearch,files(id,name)' });
      if (page) query.set('pageToken', page);
      const body = await (await this.request(`https://www.googleapis.com/drive/v3/files?${query}`)).json();
      if (!Array.isArray(body.files) || body.incompleteSearch || body.files.some(f =>
        typeof f.id !== 'string' || typeof f.name !== 'string')) throw new Error('Drive listing is incomplete or malformed.');
      files.push(...body.files);
      if (files.length > 10000) throw new Error('Drive staging folder exceeds the checkpoint limit.');
      page = body.nextPageToken;
      if (page !== undefined && (typeof page !== 'string' || !page || seen.has(page)))
        throw new Error('Invalid Drive pagination; local data was preserved.');
      if (page) seen.add(page);
    } while (page);
    return files;
  }

  async read(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/u.test(id)) throw new Error('Invalid Drive file ID.');
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 90 * 1024 * 1024) throw new Error('Drive checkpoint exceeds the download limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async create(name, bytes) {
    if (!/^(?:hive-[a-f0-9]{64}\.(?:checkpoint|erasure)|hive-part-[a-f0-9]{64}\.blob)$/u.test(name) || bytes.length > 90 * 1024 * 1024)
      throw new Error('Invalid Drive checkpoint upload.');
    const initial = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name', {
      method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(bytes.length) },
      body: JSON.stringify({ name, parents: [this.folderId], mimeType: 'application/octet-stream' }),
    });
    const location = initial.headers.get('location');
    const url = location ? new URL(location) : null;
    if (!url || url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/upload/drive/v3/files'))
      throw new Error('Drive returned an invalid upload destination.');
    const result = await (await this.request(url.href, { method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, body: bytes })).json();
    if (typeof result.id !== 'string') throw new Error('Drive upload returned no file ID; verify before retrying.');
    return result;
  }

  async remove(id, name) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(id) ||
        !/^(?:hive-[a-f0-9]{64}\.(?:checkpoint|erasure)|hive-part-[a-f0-9]{64}\.blob)$/u.test(name))
      throw new Error('Invalid managed deletion target.');
    const meta = await (await this.request(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,parents,mimeType,trashed`)).json();
    if (meta.id === this.folderId || meta.name !== name || !meta.parents?.includes(this.folderId) || meta.trashed ||
        meta.mimeType?.startsWith('application/vnd.google-apps.')) throw new Error('Drive deletion target changed or is outside the managed folder.');
    await this.request(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE' });
    if ((await this.list()).some(row => row.id === id)) throw new Error('Drive deletion remains pending.');
  }
}
