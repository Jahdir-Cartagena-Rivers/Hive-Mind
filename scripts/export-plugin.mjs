import path from 'node:path';
import { exportPlugin } from '../src/plugin-package.mjs';
import { exportRemotePlugin } from '../src/remote-plugin-package.mjs';

try {
  const options = {};
  let remote = false;
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (key === '--remote') remote = true;
    else if (key === '--include-general') options.includeGeneral = true;
    else if (['--output', '--connection-file', '--access', '--project'].includes(key)) {
      const value = process.argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing argument.');
      if (key === '--output') options.destination = path.resolve(value);
      if (key === '--connection-file') options.connectionFile = path.resolve(value);
      if (key === '--access') options.access = value;
      if (key === '--project') (options.projects ??= []).push(value);
    } else throw new Error('Unknown option.');
  }
  if (remote && Object.keys(options).some(k => k !== 'destination')) throw new Error('Remote mode preserves the existing connection; do not supply local connector settings.');
  const result = await (remote ? exportRemotePlugin(options) : exportPlugin(options));
  console.log(`Hive Mind connector exported (${result.access}, ${result.files} files). Open START_HERE.txt in the output folder.`);
} catch (error) { console.error(error.code === 'EEXIST' ? 'Output folder already exists; choose a new folder.' : error.message); process.exitCode = 1; }
