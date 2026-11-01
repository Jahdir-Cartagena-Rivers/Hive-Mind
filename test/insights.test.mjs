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
