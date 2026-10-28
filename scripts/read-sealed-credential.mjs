// Private application-to-application pipe. Never run this command as a model-facing tool.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCloudKey } from '../src/cloud-key.mjs';
import { openCredential } from '../src/sealed-credential.mjs';

async function readPrivate(file, limit) {
  if (!path.isAbsolute(file ?? '')) throw new Error();
  const stat=await fs.lstat(file); if(!stat.isFile() || stat.isSymbolicLink() || stat.size>limit) throw new Error();
  return fs.readFile(file);
}
try {
  const [file,...extra]=process.argv.slice(2); if(!file || extra.length)throw new Error();
  const config=JSON.parse(await readPrivate(file,16384));
  const origin=new URL(config.origin);
  if(origin.protocol!=='http:' || origin.hostname!=='127.0.0.1' || origin.pathname!=='/' || origin.search || origin.hash || origin.username || origin.password)throw new Error();
  const chunks=[]; let length=0;
  for await(const chunk of process.stdin){length+=chunk.length;if(length>8192)throw new Error();chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(typeof input.key!=='string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(input.key) || !path.isAbsolute(input.storePath ?? ''))throw new Error();
  const selected=config.bindings?.[input.key];
  if(!selected || path.resolve(selected.storePath)!==path.resolve(input.storePath) ||
      typeof selected.assetId!=='string' || !/^[a-f0-9-]{36}$/u.test(selected.assetId))throw new Error();
  const token=(await readPrivate(config.tokenFile,4096)).toString('utf8').trim();
  if(token.length<32 || /\s/u.test(token))throw new Error();
  const response=await fetch(`${origin.origin}/v1/assets/${selected.assetId}`,{
    headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok || response.headers.get('content-type')!=='application/octet-stream')throw new Error();
  if(Number(response.headers.get('content-length'))>16384)throw new Error();
  const parts=[];let size=0;
  for await(const part of response.body){size+=part.length;if(size>16384)throw new Error();parts.push(part);}
  const key=await loadCloudKey({file:config.protectedKeyFile,workspace:config.workspace});
  try {
    const value=openCredential(Buffer.concat(parts),{key,workspace:config.workspace,credential:input.key,owner:selected.owner});
    // Only the private consumer captures stdout; errors never include content or provider bodies.
    process.stdout.write(JSON.stringify({value}));
  } finally {key.fill(0);}
}catch{process.stderr.write('Sealed credential unavailable.');process.exitCode=1;}
