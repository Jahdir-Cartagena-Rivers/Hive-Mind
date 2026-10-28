import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOptions } from '../plugin/runtime.mjs';

export const PLUGIN_FILES = ['runtime.mjs', 'connector.json', '.mcp.json', 'mcp.claude.json',
  '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'skills/shared-memory/SKILL.md'];

/** Export a self-contained, token-free package. Never edit the AI host's settings. */
export async function exportPlugin({ destination, connectionFile, access = 'read', projects, includeGeneral = false,
  source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugin') }) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('Choose an absolute output folder.');
  const options = validateOptions({ version: 1, access,
    ...(connectionFile ? { connectionFile } : {}), ...(projects ? { projects, includeGeneral } : {}) });
  // mkdir without recursive refuses an existing folder, including linked destinations.
  await fs.mkdir(destination);
  for (const name of PLUGIN_FILES) {
    const target = path.join(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = name === 'connector.json' ? JSON.stringify(options, null, 2) + '\n' : await fs.readFile(path.join(source, name));
    await fs.writeFile(target, bytes, { flag: 'wx' });
  }
  const runtime = path.join(destination, 'runtime.mjs');
  const mcp = { mcpServers: { 'hive-mind': { command: 'node', args: [runtime] } } };
  await fs.writeFile(path.join(destination, 'mcp.local.json'), JSON.stringify(mcp, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(destination, 'codex.toml'),
    '[mcp_servers.hive-mind]\ncommand = "node"\nargs = [' + JSON.stringify(runtime) + ']\n', { flag: 'wx' });
  await fs.mkdir(path.join(destination, '.agents/plugins'), { recursive: true });
  await fs.writeFile(path.join(destination, '.agents/plugins/marketplace.json'), JSON.stringify({
    name: 'hive-mind', interface: { displayName: 'Hive Mind' }, plugins: [{ name: 'hive-mind',
      source: { source: 'local', path: './' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  }, null, 2) + '\n', { flag: 'wx' });
  await fs.copyFile(path.join(source, '../LICENSE'), path.join(destination, 'LICENSE'), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(destination, 'START_HERE.txt'), `Hive Mind AI connector\n\n` +
    `1. Start Hive Mind on this host. Node.js 24.13+ must be on PATH.\n` +
    `2. Run: node "${runtime}" --check\n` +
    `3. Claude Code: claude --plugin-dir "${destination}"\n` +
    `   Codex: codex plugin marketplace add "${destination}"\n` +
    `          codex plugin add hive-mind@hive-mind\n` +
    `   Or merge the included codex.toml entry into your chosen Codex config.\n` +
    `   Other stdio hosts: merge the hive-mind entry from mcp.local.json.\n` +
    `4. Enable the host's connection, then ask it to recall a known Hive Mind fact.\n\n` +
    `Access: ${access === 'read' ? 'read-only' : 'read and write'}. ` +
    `${projects ? 'Only configured project facts' + (includeGeneral ? ' plus general facts' : '') + '; task/file tools are hidden.' : 'All projects, general facts and continuity/reference tools.'}\n` +
    `Connector settings are in connector.json. No credential is included here.\n` +
    `The connector reads your private host connection file on each request.\n` +
    `Project and read-only restrictions apply at this connector, not to other holders\n` +
    `of the underlying service credential. Do not share your connection file.\n\n` +
    `These tools read the same service; they do not import or duplicate memory.\n` +
    `To use another computer, first join that host to your existing encrypted Hive Mind\n` +
    `sync using its protected configuration. Export without this host's connection path,\n` +
    `or select that computer's private connection file. Keys stay outside the package.\n` +
    `A cloud-only AI without stdio needs a reachable authenticated HTTPS MCP deployment;\n` +
    `this package does not publish your computer or provision public OAuth hosting.\n` +
    `Installing a plugin does not prove automatic recall, saving or cloud sync.\n`, { flag: 'wx' });
  return { destination, access, projects: projects ?? null, files: PLUGIN_FILES.length + 5 };
}
