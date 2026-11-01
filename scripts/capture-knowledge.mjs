import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {scanKnowledgeFolder} from '../src/knowledge-capture.mjs';
const args=process.argv.slice(2);
const value=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const folder=value('--folder'), project=value('--project'), commit=args.includes('--commit'), watch=args.includes('--watch');
if(!folder || (!project && !args.includes('--general')) || (watch && !commit)) throw Error('Use --folder <absolute path> --project <name> (or --general), optional --exclude <prefix>, --commit and --watch. Watch requires --commit.');
const connection=JSON.parse(await fs.readFile(value('--connection')??path.join(os.homedir(),'.hive-mind','connection.json'),'utf8'));
const url=new URL(connection.origin);
if(!((url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)) || url.protocol==='https:') || url.username || url.password || url.search || url.hash || url.pathname!=='/' || typeof connection.token!=='string' || connection.token.length<32) throw Error('Invalid private connection descriptor.');
let running=false;
async function scan(){
 if(running)return;running=true;
 try{
  const found=await scanKnowledgeFolder(folder,{exclude:value('--exclude')?.split(',')??[]});
  if(!found.entries.length){console.log(JSON.stringify({created:0,skipped:found.skipped.length,truncated:found.truncated}));return;}
  // Each request stays below the service body limit, including JSON escaping.
  let created=0,duplicates=0,failed=0;
  for(const entry of found.entries){
   const r=await fetch(new URL('/v1/knowledge/import',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:JSON.stringify({scope:project?'project':'general',project,source:{type:'import',threadId:found.threadId,provider:'folder-capture'},entries:[entry],dryRun:!commit})});
   if(!r.ok)throw Error(`Capture rejected (HTTP ${r.status}); existing entries retained.`);
   const report=await r.json();created+=report.created.length;duplicates+=report.duplicates.length;failed+=report.failed.length;
  }
  console.log(JSON.stringify({dryRun:!commit,created,duplicates,failed,skipped:found.skipped.length,truncated:found.truncated}));
 }catch(e){console.error(e.message);if(!watch)process.exitCode=1;}finally{running=false;}
}
await scan();
if(watch)setInterval(scan,5000);
