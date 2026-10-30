import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Instructions-only package for an already working remote connection. No new transport. */
export async function exportRemotePlugin({ destination }) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('Choose an absolute output folder.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  await fs.mkdir(destination); // Reject existing outputs; never modify a host profile.
  for (const dir of ['.codex-plugin', '.claude-plugin', 'skills/remote-continuity', '.agents/plugins'])
    await fs.mkdir(path.join(destination, dir), { recursive: true });
  const manifest = { name: 'hive-mind-remote', version, description: 'Use the existing Drive-backed Hive Mind connection without another installation.', author: { name: 'Hive Mind' }, skills: './skills/' };
  for (const dir of ['.codex-plugin', '.claude-plugin'])
    await fs.writeFile(path.join(destination, dir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await fs.copyFile(path.join(root, 'plugin/skills/remote-continuity/SKILL.md'), path.join(destination, 'skills/remote-continuity/SKILL.md'), fs.constants.COPYFILE_EXCL);
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(destination, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'hive-mind-remote', plugins: [{ name: 'hive-mind-remote', source: { source: 'local', path: './' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(destination, 'START_HERE.txt'),
    'Hive Mind remote workflow package\n\n' +
    'Use this with the working Drive-backed setup already configured on the AI host.\n' +
    'Load skills/remote-continuity/SKILL.md through that host\'s supported skill or\n' +
    'persistent-instruction mechanism. Hosts with a compatible plugin loader may\n' +
    'load the supplied manifests. Native Grokbot/Dot plugin-loader support is not\n' +
    'established by this export; use their existing instruction mechanism as needed.\n\n' +
    'This package adds instructions, not account tools or an execution service.\n' +
    'Keep the existing connected account, exact memory store, helpers and routines.\n' +
    'No desktop app, new server, billing account, credentials or key are included.\n' +
    'It does not replace the currently working setup or create a new memory store.\n\n' +
    'Check packaging parity through the existing connection: recall a known fact;\n' +
    'save a clearly synthetic fact, read it from the other host, correct the same\n' +
    'fact, then forget it and check the existing deletion/cleanup receipt.\n' +
    'Preserve ordinary application activity and do not alter credentials to test it.\n', { flag: 'wx' });
  return { destination, mode: 'existing-remote', access: 'existing connection', files: 6 };
}
