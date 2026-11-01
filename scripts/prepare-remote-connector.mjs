import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDesktopCloudSettings } from '../src/cloud-scheduler.mjs';

// Generate host-native command registration only. No provider calls, keys, restart or installation.
try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--profile', '--output', '--access'].includes(args[i]) || !args[i + 1]) throw new Error('Use --profile <existing-profile> --output <new-file> --access read|write.');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!path.isAbsolute(options.profile ?? '') || !path.isAbsolute(options.output ?? '') ||
      await fs.realpath(options.profile) !== path.resolve(options.profile) || !['read', 'write'].includes(options.access))
    throw new Error('Existing absolute profile, new absolute output file and explicit read/write access required.');
  if (!await readDesktopCloudSettings(options.profile)) throw new Error('The existing profile has no enabled Drive connection.');
  const command = { command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote-connector.mjs'),
    '--profile', options.profile, '--access', options.access] };
  await fs.writeFile(options.output, JSON.stringify({ mcpServers: { 'hive-mind': command } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Native MCP registration file prepared. No account, store, process or host registration was changed.');
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Registration output exists; choose a new file.' : error.message);
  process.exitCode = 1;
}
