import { test } from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { startCloudHost } from '../scripts/cloud-host.mjs';

test('headless host requires opt-in, owns its profile, exposes local memory offline and closes cleanly',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hive-headless-'));let host;
  t.after(async()=>{await host?.close();await fs.rm(directory,{recursive:true,force:true});});
  await assert.rejects(startCloudHost({profile:directory,port:0}),/requires an enabled/);
  const settings={version:1,enabled:true,workspace:'synthetic',client:'headless',bootstrap:'join',
    protectedKeyFile:path.join(directory,'absent-key.json'),transportOptions:{folderId:'synthetic',fileId:'synthetic',expectedName:'synthetic.enc',userId:'synthetic',connectedAccountId:'synthetic'}};
  await fs.writeFile(path.join(directory,'drive-sync.json'),JSON.stringify(settings));
  host=await startCloudHost({profile:directory,port:0});
  assert.equal((await fetch(host.origin+'/health')).status,200);
  assert.equal((await fetch(host.origin+'/v1/status')).status,401);
  await assert.rejects(startCloudHost({profile:directory,port:0}),/running Hive Mind owner/);
  const until=Date.now()+5000;while(host.status().state!=='offline'&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
  assert.equal(host.status().state,'offline');assert.equal(host.status().errorCode,'ENOENT');
  await host.close();await host.close();
  assert.equal(await fs.access(path.join(directory,'data/hive-mind.owner')).then(()=>true,()=>false),false);
});
