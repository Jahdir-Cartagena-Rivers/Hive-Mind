import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveCloudKey } from '../src/cloud-key.mjs';
import { startHiveMind } from '../src/service.mjs';
import { importBrainFile,forgetBrainRecord } from '../src/brain.mjs';
import { sealCredential,openCredential } from '../src/sealed-credential.mjs';

test('sealed credential retains exact value with domain, account and workspace binding',()=>{
  const options={key:randomBytes(32),workspace:'synthetic',credential:'universal_ats_password',owner:'synthetic@example.test'};
  const value='generated credential + punctuation 123!';const bytes=sealCredential(value,options);
  assert.equal(bytes.includes(Buffer.from(value)),false);assert.equal(openCredential(bytes,options),value);
  assert.equal(openCredential(bytes,{...options,owner:'SYNTHETIC@EXAMPLE.TEST'}),value);
  for(const change of [{key:randomBytes(32)},{workspace:'another'},{credential:'other_password'},{owner:'other@example.test'}])
    assert.throws(()=>openCredential(bytes,{...options,...change}),/could not be opened/);
  const corrupt=JSON.parse(bytes);corrupt.data=Buffer.alloc(32,7).toString('base64');
  assert.throws(()=>openCredential(Buffer.from(JSON.stringify(corrupt)),options),/could not be opened/);
  assert.throws(()=>sealCredential('',options),/Invalid/);
});

test('private helper reads exact sealed asset, rejects another profile/account and stops after Forget',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hive-credential-'));
  const old=process.env.COMPOSIO_API_KEY;process.env.COMPOSIO_API_KEY='synthetic-host-wrapping-secret-not-real';
  let service;
  t.after(async()=>{await service?.close();if(old===undefined)delete process.env.COMPOSIO_API_KEY;else process.env.COMPOSIO_API_KEY=old;await fs.rm(directory,{recursive:true,force:true});});
  const token=randomBytes(32).toString('hex'), workspace='synthetic-vault',key=randomBytes(32);
  const keyFile=path.join(directory,'protected.json'),tokenFile=path.join(directory,'token');
  await saveCloudKey(key,{file:keyFile,workspace,provider:'host'});await fs.writeFile(tokenFile,token);
  service=await startHiveMind({stateDirectory:path.join(directory,'state'),token,port:0});
  const options={key,workspace,credential:'universal_ats_password',owner:'synthetic@example.test'};
  const bytes=sealCredential('synthetic-private-pipe-value',options),file=path.join(directory,'state','hive-mind.json');
  const imported=await importBrainFile(file,{scope:'project',project:'Synthetic',title:'Sealed test credential',filename:'credential.enc',
    base64:bytes.toString('base64'),source:{threadId:'test',provider:'test',type:'user'}});
  const selected=path.join(directory,'app','protected_secrets.json'),configFile=path.join(directory,'private.json');
  const config={origin:service.origin,workspace,protectedKeyFile:keyFile,tokenFile,bindings:{universal_ats_password:{storePath:selected,owner:options.owner,assetId:imported.id}}};
  await fs.writeFile(configFile,JSON.stringify(config));
  const helper=fileURLToPath(new URL('../scripts/read-sealed-credential.mjs',import.meta.url));
  const run=async(input)=>{
    // execFile has no stdin option, so use a captured child with an explicit private pipe.
    const {spawn}=await import('node:child_process');
    return new Promise(resolve=>{const child=spawn(process.execPath,[helper,configFile],{env:{...process.env},windowsHide:true,stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      child.stdin.end(JSON.stringify(input));child.on('close',code=>resolve({code,stdout,stderr}));});
  };
  const input={key:options.credential,storePath:selected};
  const valid=await run(input);assert.equal(valid.code,0);assert.deepEqual(JSON.parse(valid.stdout),{value:'synthetic-private-pipe-value'});assert.equal(valid.stderr,'');
  for(const invalid of [{...input,storePath:path.join(directory,'other')},{...input,key:'other_password'}]){
    const result=await run(invalid);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.equal(result.stderr.includes('synthetic-private-pipe-value'),false);
  }
  config.bindings.universal_ats_password.owner='another@example.test';await fs.writeFile(configFile,JSON.stringify(config));
  assert.equal((await run(input)).code,1);config.bindings.universal_ats_password.owner=options.owner;await fs.writeFile(configFile,JSON.stringify(config));
  await forgetBrainRecord(file,{id:imported.id,revision:imported.revision});
  const forgotten=await run(input);assert.equal(forgotten.code,1);assert.equal(forgotten.stdout,'');
});
