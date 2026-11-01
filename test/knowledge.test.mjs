import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {importKnowledge, knowledgeView} from '../src/knowledge.mjs';
import {saveBrainRecord, brainSnapshot, forgetBrainRecord, brainContext} from '../src/brain.mjs';
process.env.HIVE_MIND_SEMANTIC='off';
test('evidence import, dedup, immutable originals, scoped decisions and rollback', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hive-knowledge-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'memory.json');
 const source={threadId:'test',provider:'fixture',type:'user'};
 const input={scope:'project',project:'A',source,entries:[{text:'Keep Composio for connected accounts',speaker:'user',origin:'chat:1',recordedAt:'2026-11-01T00:00:00Z'}]};
 const preview=await importKnowledge(file,input); assert.equal(preview.created.length,1);
 assert.equal((await brainSnapshot(file)).total,0);
 const result=await importKnowledge(file,{...input,dryRun:false});
 assert.equal((await importKnowledge(file,{...input,dryRun:false})).duplicates.length,1);
 const evidence=(await brainSnapshot(file)).records[0];
 await assert.rejects(saveBrainRecord(file,{...Object.fromEntries(['id','kind','scope','project','title','source','revision'].map(k=>[k,evidence[k]])),data:{...evidence.data,text:'changed'}}),/immutable/);
 const base={scope:'project',project:'A',source,title:'Account layer'};
 const decision=await saveBrainRecord(file,{...base,kind:'decision',data:{statement:'Keep Composio',status:'proposed',rationale:'Existing bindings',referenceIds:result.created}});
 await saveBrainRecord(file,{...base,kind:'decision',id:decision.id,revision:decision.revision,data:{...decision.data,status:'accepted'}});
 const rows=(await knowledgeView(file,{projects:['A']})).rows;
 const saved=rows.find(r=>r.kind==='decision'); assert.equal(saved.history[0].data.status,'proposed'); assert.equal(saved.originals[0].data.text,input.entries[0].text);
 assert.equal((await knowledgeView(file,{projects:['B']})).rows.length,0);
 await assert.rejects(saveBrainRecord(file,{...base,scope:'general',project:null,kind:'decision',data:decision.data}),/narrower/);
 await assert.rejects(importKnowledge(file,{...input,entries:[{text:'bad'}],dryRun:false}),/Each entry/);
 const derived=await saveBrainRecord(file,{...base,source:{...source,type:'agent'},kind:'interpretation',data:{summary:'Account integration',referenceIds:result.created,model:'fixture',schema:'topics-v1',runId:'run-1',active:true}});
 await saveBrainRecord(file,{...base,source:derived.source,kind:'interpretation',id:derived.id,revision:derived.revision,data:{...derived.data,active:false}});
 assert.equal((await knowledgeView(file)).rows.some(r=>r.id===derived.id),false);
 const context=await brainContext(file,{projects:['A'],query:'Account integration'});
 assert.ok(!context.context.includes('run-1'));
 await forgetBrainRecord(file,{id:evidence.id,revision:evidence.revision});
 const remaining=(await brainSnapshot(file)).records;
 assert.ok(!remaining.some(r=>[evidence.id,derived.id,decision.id].includes(r.id)));
 assert.equal((await importKnowledge(file,{...input,dryRun:false})).excluded.length,1);
 // Neighboring existing task route remains usable.
 await saveBrainRecord(file,{...base,kind:'task',data:{objective:'Continue',status:'open'}});
});
import {startHiveMind} from '../src/service.mjs';
test('knowledge HTTP authorization, invalid batch rejection and restart persistence',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hive-knowledge-http-'));
 let service=await startHiveMind({stateDirectory:dir,token:'write-fixture-token-000000000000000000000',readToken:'read-fixture-token-000000000000000000000',port:0});
 t.after(async()=>{await service.close();await fs.rm(dir,{recursive:true,force:true});});
 const api=async(route,body,token='write-fixture-token-000000000000000000000')=>{
  const r=await fetch(service.origin+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
 };
 const input={scope:'general',source:{type:'import',provider:'fixture',threadId:'http'},entries:[{text:'Synthetic source',speaker:'user',origin:'fixture',recordedAt:'2026-11-01T00:00:00Z'}],dryRun:false};
 assert.equal((await api('/v1/knowledge/import',input,'read-fixture-token-000000000000000000000')).status,403);
 assert.equal((await api('/v1/knowledge/import',{...input,entries:[...input.entries,{}]})).status,400);
 assert.equal((await api('/v1/knowledge/view',{},'read-fixture-token-000000000000000000000')).body.rows.length,0);
 assert.equal((await api('/v1/knowledge/import',input)).body.created.length,1);
 await service.close();service=await startHiveMind({stateDirectory:dir,token:'write-fixture-token-000000000000000000000',readToken:'read-fixture-token-000000000000000000000',port:0});
 assert.equal((await api('/v1/knowledge/view',{},'read-fixture-token-000000000000000000000')).body.rows[0].data.text,'Synthetic source');
 assert.equal((await api('/v1/knowledge/view',{projects:'invalid'})).status,400);
});


import {normalizeKnowledgeExport} from '../src/knowledge-import.mjs';
test('export adapters retain exact speaker/text/date and report unsupported content',()=>{
 const source='  exact words\nwith spacing  ';
 const chat=normalizeKnowledgeExport('chatgpt',[{id:'c1',mapping:{n1:{message:{author:{role:'user'},content:{parts:[source,{image:'opaque'}]},create_time:1793491200}},n2:{message:{author:{role:'assistant'},content:{parts:['reply']},create_time:1793491201}}}}]);
 assert.equal(chat.entries[0].text,source);assert.equal(chat.entries[0].speaker,'user');assert.equal(chat.entries[1].speaker,'assistant');assert.equal(chat.issues.length,1);
 const claude=normalizeKnowledgeExport('claude',[{uuid:'c2',chat_messages:[{uuid:'m',text:source,sender:'human',created_at:'2026-11-01T00:00:00Z'}]}]);
 assert.equal(claude.entries[0].text,source);assert.equal(claude.entries[0].origin,'claude:c2/m#0');
 assert.throws(()=>normalizeKnowledgeExport('unknown',[]),/Supported/);
 assert.equal(normalizeKnowledgeExport('claude',[{uuid:'c',chat_messages:[{uuid:'m',text:'no date',sender:'human'}]}]).issues.length,1);
});

import {scanKnowledgeFolder} from '../src/knowledge-capture.mjs';
test('capture reads only selected text notes and honors hidden files and exclusions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hive-capture-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'note.md'),'Original note');await fs.writeFile(path.join(root,'.private.txt'),'secret');
 await fs.writeFile(path.join(root,'image.png'),'opaque');await fs.mkdir(path.join(root,'excluded'));await fs.writeFile(path.join(root,'excluded','other.txt'),'Skip');
 const result=await scanKnowledgeFolder(root,{exclude:['excluded']});assert.equal(result.entries.length,1);assert.equal(result.entries[0].text,'Original note');assert.equal(result.entries[0].speaker,'unspecified');assert.equal(result.truncated,false);
});
