import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportRemotePlugin } from '../src/remote-plugin-package.mjs';

test('existing-remote package has guidance and manifests, no runtime, credentials or new connection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-remote-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'remote');
  await exportRemotePlugin({ destination });
  for (const name of ['.codex-plugin', '.claude-plugin']) {
    const manifest = JSON.parse(await fs.readFile(path.join(destination, name, 'plugin.json')));
    assert.equal(manifest.name, 'hive-mind-remote');
    assert.equal(manifest.mcpServers, undefined);
    assert.equal(manifest.skills, './skills/');
  }
  for (const name of ['connector.json', '.mcp.json', 'runtime.mjs'])
    await assert.rejects(fs.access(path.join(destination, name)));
  assert.match(await fs.readFile(path.join(destination, 'skills/remote-continuity/SKILL.md'), 'utf8'), /Keep credentials and encryption keys/);
  await assert.rejects(exportRemotePlugin({ destination }), { code: 'EEXIST' });
});
