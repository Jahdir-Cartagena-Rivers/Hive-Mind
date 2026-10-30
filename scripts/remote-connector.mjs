import { createRemoteConnector } from '../src/remote-connector.mjs';
import { runStdio } from '../plugin/runtime.mjs';

let connector;
try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--profile', '--access'].includes(args[i]) || !args[i + 1]) throw new Error('Use --profile <existing-absolute-profile> --access read|write.');
    options[args[i].slice(2)] = args[i + 1];
  }
  connector = await createRemoteConnector(options);
  // The MCP host starts this command on demand, including after its computer restarts.
  const stop = () => { void connector.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  await runStdio(connector.handle);
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
finally { await connector?.close(); }
