import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {syncHiveVectors,semanticRecall,semanticRuntimeStatus} from '../src/core/semantic.ts';
const args=process.argv.slice(2), index=args.indexOf('--models');
if(index<0 || !path.isAbsolute(args[index+1]??''))throw Error('Supply --models <absolute directory with already-downloaded BGE files>. No download is performed by this benchmark.');
const evidence=await fs.mkdtemp(path.join(os.tmpdir(),'hive-inference-benchmark-'));
const file=path.join(evidence,'hive-mind.json'), models=path.join(evidence,'hive-mind-models');
for(const name of ['tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx']){
 const target=path.join(models,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(args[index+1],name),target,fs.constants.COPYFILE_EXCL);
}
delete process.env.HIVE_MIND_SEMANTIC;
const subjects=['Transport','Design','Storage','Sync','Materials','Tools'];
const facts=['Drives an automobile to work.','Prefers dark themes and curved proportions.','Uses SQLite for local durable records.','Shares encrypted memory through Drive.','Copper fins dissipate heat.','Keeps Composio for connected accounts.'];
const memories=Array.from({length:120},(_,i)=>({id:`synthetic-${i}`,scope:'general',project:null,subject:`${subjects[i%6]} ${i}`,fact:facts[i%6],sourceThreadId:'synthetic-benchmark',createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'}));
const start=performance.now();await syncHiveVectors(file,memories);const indexingMs=performance.now()-start;
const queries=['car commute','night design','local database','encrypted synchronization','cooling material','account connections'];
const timings={uncached:[],cached:[]};const results=new Map();
for(const mode of ['uncached','cached']){
 process.env.HIVE_MIND_INFERENCE_CACHE=mode==='uncached'?'off':'on';
 for(const query of queries)await semanticRecall(file,query,memories);
 for(let round=0;round<5;round++)for(const query of queries){
  const started=performance.now();const hit=await semanticRecall(file,query,memories);timings[mode].push(performance.now()-started);
  const ids=hit?.map(m=>m.id);if(mode==='uncached')results.set(query,ids);else assert.deepEqual(ids,results.get(query));
 }
}
const summarize=values=>{const sorted=values.toSorted((a,b)=>a-b);return {p50:+sorted[Math.floor(sorted.length*.5)].toFixed(3),p95:+sorted[Math.floor(sorted.length*.95)].toFixed(3)};};
const result={model:'Xenova/bge-small-en-v1.5',backend:'local ONNX CPU',records:memories.length,samplesPerMode:30,indexingMs:+indexingMs.toFixed(2),uncachedMs:summarize(timings.uncached),cachedMs:summarize(timings.cached),identicalRankings:true,runtime:semanticRuntimeStatus(file),node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,evidence,limits:'Warm model, repeated six-query workload and synthetic records; excludes HTTP, network, cold startup and decision-model reranking.'};
await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
