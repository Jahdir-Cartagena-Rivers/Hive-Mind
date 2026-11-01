import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {inferMemoryReferences} from '../src/inference.mjs';
import {saveBrainRecord,forgetBrainRecord} from '../src/brain.mjs';
import {startHiveMind} from '../src/service.mjs';
import {createConnector} from '../plugin/runtime.mjs';
process.env.HIVE_MIND_SEMANTIC='off';
test('typed references honor current scope, links, rejection states, limits and deletion',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hive-infer-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'hive-mind.json');
 const base={scope:'project',project:'A',source:{type:'user',threadId:'test',provider:'fixture'}};
 const original=await saveBrainRecord(file,{...base,kind:'evidence',title:'Account connection source',data:{text:'Keep Composio',speaker:'user',origin:'test',recordedAt:'2026-11-01T00:00:00Z'}});
 const decision=await saveBrainRecord(file,{...base,kind:'decision',title:'Integration decision',data:{statement:'Keep current account layer',status:'accepted',rationale:'Existing bindings',referenceIds:[original.id]}});
 const rejected=await saveBrainRecord(file,{...base,kind:'decision',title:'Composio rejected alternative',data:{statement:'Replace Composio',status:'rejected',rationale:'Abandoned',referenceIds:[original.id]}});
 assert.equal((await inferMemoryReferences(file,{query:'Composio'})).references.length,0);
 const result=await inferMemoryReferences(file,{query:'Composio',projects:['A']});
 assert.ok(result.references.some(r=>r.id===decision.id));assert.ok(!result.references.some(r=>r.id===rejected.id));assert.equal(result.calibratedConfidence,null);
 const exact=await inferMemoryReferences(file,{query:decision.id,projects:['A']});assert.equal(exact.references[0].basis,'exact-id');
 const bounded=await inferMemoryReferences(file,{query:'Composio',projects:['A'],limit:1,maxChars:500});assert.ok(bounded.references.length<=1);assert.ok(JSON.stringify(bounded.references).length<=500);
 await forgetBrainRecord(file,{id:original.id,revision:original.revision});assert.equal((await inferMemoryReferences(file,{query:'Composio',projects:['A']})).references.length,0);
 await assert.rejects(inferMemoryReferences(file,{query:'x',projects:'A'}),/Provide/);
});
test('inference HTTP and connector are read-only; scoped connector cannot broaden access',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hive-infer-http-')),token=randomBytes(32).toString('hex'),readToken=randomBytes(32).toString('hex');
 const service=await startHiveMind({stateDirectory:dir,token,readToken,port:0});t.after(async()=>{await service.close();await fs.rm(dir,{recursive:true,force:true});});
 const connectionFile=path.join(dir,'connection.json');await fs.writeFile(connectionFile,JSON.stringify({origin:service.origin,token:readToken}));
 const adapter=createConnector({version:1,access:'read',connectionFile});
 const list=await adapter({jsonrpc:'2.0',id:1,method:'tools/list'});assert.ok(list.result.tools.some(t=>t.name==='hive_mind_infer_references'));
 const result=await adapter({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'hive_mind_infer_references',arguments:{query:'fixture'}}});assert.ok(!result.result.isError);
 const scoped=createConnector({version:1,access:'read',connectionFile,projects:['A']});const limited=await scoped({jsonrpc:'2.0',id:3,method:'tools/list'});assert.ok(!limited.result.tools.some(t=>t.name==='hive_mind_infer_references'));
 const r=await fetch(service.origin+'/v1/inference/recall',{method:'POST',headers:{authorization:`Bearer ${readToken}`,'content-type':'application/json'},body:JSON.stringify({query:'fixture'})});assert.equal(r.status,200);
});

import {replicaCompatibility,legacyRecordKinds} from '../src/compatibility.mjs';
import {exportBrain,restoreBrain} from '../src/brain.mjs';
test('legacy capability preflight rejects new kinds without mutation; upgraded reader round-trips',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hive-compat-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'first','hive-mind.json');
 await saveBrainRecord(file,{kind:'evidence',scope:'general',title:'Synthetic original',source:{type:'user',threadId:'fixture',provider:'test'},data:{text:'Exact synthetic original',speaker:'user',origin:'fixture',recordedAt:'2026-11-01T00:00:00Z'}});
 const before=await fs.readFile(file);
 const legacy=await replicaCompatibility(file,{supportedRecordKinds:legacyRecordKinds});assert.equal(legacy.compatible,false);assert.deepEqual(legacy.unsupportedRecordKinds,['evidence']);assert.deepEqual(await fs.readFile(file),before);
 const modern=await replicaCompatibility(file,{supportedRecordKinds:legacy.supportedRecordKinds});assert.equal(modern.compatible,true);
 const archive=await exportBrain(file),target=path.join(root,'second','hive-mind.json');await restoreBrain(target,archive);assert.deepEqual((await exportBrain(target)).store.continuity.records,archive.store.continuity.records);
});
