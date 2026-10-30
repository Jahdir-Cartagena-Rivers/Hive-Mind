// Read-only provider probe using the existing protected host configuration.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadComposioCredential } from '../src/cloud-key.mjs';
import { createAccountLinkClient } from '../src/account-link.mjs';

try {
  const profile = process.argv[2] ?? (process.platform === 'win32' ? path.join(process.env.APPDATA, 'Hive Mind') : null);
  if (!profile || !path.isAbsolute(profile) || process.argv.length > 3) throw new Error('Supply an absolute host profile path.');
  const config = JSON.parse(await fs.readFile(path.join(profile, 'drive-sync.json'), 'utf8'));
  if (config.version !== 1 || !config.enabled || !config.composioCredentialFile || !config.workspace || !config.transportOptions)
    throw new Error('Enabled protected host configuration is required.');
  const client = createAccountLinkClient({ credential: () => loadComposioCredential({ file: config.composioCredentialFile, workspace: config.workspace }) });
  const binding = { userId: config.transportOptions.userId, accountId: config.transportOptions.connectedAccountId };
  const session = await client.createSession(binding);
  const reuse = await client.begin(session);
  const result = await client.verifyDrive(binding);
  console.log(JSON.stringify({ sessionCreated: true, existingAccountReused: reuse.status === 'connected', providerVerified: result.providerVerified,
    logId: result.logId ?? null, reauthorized: false, configuredCloudEndpoint: false }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
