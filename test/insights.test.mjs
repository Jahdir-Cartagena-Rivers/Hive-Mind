import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {saveBrainRecord} from '../src/brain.mjs';
import {memoryInsights} from '../src/insights.mjs';
test('insights show explicit conflict and outcome with project isolation',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hive-insights-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'store.json');
 const base={scope:'project',project:'A',source:{type:'user',threadId:'test',provider:'fixture'}};
 const one=await saveBrainRecord(file,{...base,kind:'entity',title:'First',data:{description:'First statement',entityType:'idea'}});
 const two=await saveBrainRecord(file,{...base,kind:'entity',title:'Second',data:{description:'Second statement',entityType:'idea'}});
 await saveBrainRecord(file,{...base,kind:'relation',title:'Conflict',data:{from:one.id,to:two.id,relationship:'contradicts'}});
 await saveBrainRecord(file,{...base,kind:'task',title:'Open task',data:{objective:'Follow up',status:'open'}});
 const result=await memoryInsights(file,{projects:['A']});assert.equal(result.contradictions.length,1);assert.equal(result.resurfaced.length,1);
 assert.equal((await memoryInsights(file,{projects:['B']})).contradictions.length,0);
 await assert.rejects(memoryInsights(file,{projects:'A'}),/Invalid/);
});

test('repeated user corrections are suggestions and never alter preferences',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hive-corrections-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'store.json');
 const base={kind:'preference',scope:'project',project:'A',title:'Palette',source:{type:'user',threadId:'user-chat',provider:'test'}};
 let record=await saveBrainRecord(file,{...base,data:{statement:'blue',polarity:'like',context:'design'}});
 record=await saveBrainRecord(file,{...base,id:record.id,revision:record.revision,data:{statement:'green',polarity:'like',context:'design'}});
 record=await saveBrainRecord(file,{...base,id:record.id,revision:record.revision,data:{statement:'dark green',polarity:'like',context:'design'}});
 const result=await memoryInsights(file,{projects:['A']});assert.equal(result.correctionSuggestions[0].statement,'dark green');assert.equal(result.correctionSuggestions[0].label,'suggestion');assert.equal((await memoryInsights(file,{projects:['B']})).correctionSuggestions.length,0);
});
