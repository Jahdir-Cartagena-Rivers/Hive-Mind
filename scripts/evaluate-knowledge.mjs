import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {saveBrainRecord,brainSnapshot,brainContext} from '../src/brain.mjs';
import {knowledgeView} from '../src/knowledge.mjs';
process.env.HIVE_MIND_SEMANTIC='off';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hive-knowledge-eval-'));
try {
 const file=path.join(dir,'brain.json');
 const base={scope:'project',project:'Fixture',source:{type:'user',threadId:'eval',provider:'synthetic'}};
 const evidence=await saveBrainRecord(file,{...base,kind:'evidence',title:'Account integration source',data:{text:'Keep Composio for connected accounts.',speaker:'user',origin:'fixture:1',recordedAt:'2026-11-01T00:00:00Z'}});
 const decision=await saveBrainRecord(file,{...base,kind:'decision',title:'Account integration decision',data:{statement:'Keep Composio',status:'accepted',rationale:'Existing account bindings',referenceIds:[evidence.id]}});
 const rejected=await saveBrainRecord(file,{...base,kind:'decision',title:'Account integration alternative',data:{statement:'Replace Composio',status:'rejected',rationale:'Abandoned alternative',referenceIds:[evidence.id]}});
 const results=[];
 for(const query of ['Composio','connected accounts','Account integration']) {
  const start=performance.now();const raw=await brainSnapshot(file,{query,projects:['Fixture']});const rawMs=performance.now()-start;
  const contextStart=performance.now();const context=await brainContext(file,{query,projects:['Fixture']});const contextMs=performance.now()-contextStart;
  const view=await knowledgeView(file,{query,projects:['Fixture']});
  const current=view.rows.find(r=>r.id===decision.id);
  results.push({query,rawSearch:{hitAt3:raw.records.slice(0,3).some(r=>r.id===decision.id),characters:JSON.stringify(raw).length,ms:+rawMs.toFixed(2)},workingContext:{containsCurrentDecision:context.context.includes(decision.id),containsRejectedDecision:context.context.includes(rejected.id),characters:context.context.length,ms:+contextMs.toFixed(2)},originalEvidenceResolved:current?.originals.some(r=>r.id===evidence.id)??false});
 }
 console.log(JSON.stringify({synthetic:true,semanticIndex:false,node:process.version,results,limits:'Fixture correctness and size/latency comparison only; no model-quality or native-language speed claim.'},null,2));
 if(results.some(r=>!r.workingContext.containsCurrentDecision || r.workingContext.containsRejectedDecision))process.exitCode=1;
} finally {await fs.rm(dir,{recursive:true,force:true});}
