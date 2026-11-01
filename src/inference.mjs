import {readHiveMind} from './core/store.ts';
import {continuityMemories} from './core/continuity.ts';
import {semanticRank,continuityIndexFile,semanticRuntimeStatus} from './core/semantic.ts';
import {BrainError} from './brain.mjs';

/** Typed local retrieval decisions. Model scores are similarities, not truth probabilities. */
export async function inferMemoryReferences(file, {query,projects=[],limit=12,maxChars=12000}={}) {
 if(typeof query!=='string' || !query.trim() || query.length>4000 || !Array.isArray(projects) || projects.length>100 || !projects.every(p=>typeof p==='string' && p.length<=160) || !Number.isInteger(limit) || limit<1 || limit>32 || !Number.isInteger(maxChars) || maxChars<500 || maxChars>24000)throw new BrainError(400,'Provide a query, project list, limit 1–32 and maxChars 500–24000.');
 const normalize=v=>String(v).trim().toLowerCase().replace(/[\s_-]+/gu,'');
 const allowed=r=>r.scope==='general' || projects.some(p=>normalize(p)===normalize(r.project));
 const store=await readHiveMind(file);
 const records=(store.continuity?.records??[]).filter(r=>allowed(r) && !['client','relation'].includes(r.kind) && !(r.kind==='interpretation'&&!r.data.active) && !(r.kind==='decision'&&['rejected','superseded'].includes(r.data.status)));
 const recordIds=new Set(records.map(r=>r.id));
 const facts=store.memories.filter(r=>allowed(r) && r.kind!=='skill');
 const candidates=[...facts,...continuityMemories(records)];
 const byId=new Map(candidates.map(r=>[r.id,r]));
 const exact=candidates.find(r=>r.id===query.trim());
 let retrieval='local',semantic=[];
 if(!exact){
  try{
   const hits=await Promise.all([semanticRank(file,query,facts,32),semanticRank(continuityIndexFile(file),query,continuityMemories(records),32)]);
   semantic=hits.flatMap(h=>h??[]);retrieval=hits.some(h=>h!==undefined)?'ready':'local';
  }catch{retrieval='degraded';}
 }
 const terms=query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)??[];
 const scored=new Map();
 for(const memory of candidates){
  const text=JSON.stringify([memory.subject,memory.fact]).toLowerCase();
  const lexical=terms.reduce((sum,term)=>sum+(text.includes(term)?1:0),0);
  if(lexical)scored.set(memory.id,{memory,score:lexical,basis:'keyword'});
 }
 for(const hit of semantic){
  const prior=scored.get(hit.memory.id);
  scored.set(hit.memory.id,{memory:hit.memory,score:(prior?.score??0)+hit.score,basis:prior?'hybrid':'embedding',similarity:hit.score});
 }
 // Evidence can retrieve a derived current decision even if its wording differs.
 for(const record of records.filter(r=>['decision','interpretation'].includes(r.kind))){
  if(!scored.has(record.id) && (record.data.referenceIds??[]).some(id=>scored.has(id)))scored.set(record.id,{memory:byId.get(record.id),score:.5,basis:'linked-evidence'});
 }
 const ranked=exact?[{memory:exact,score:1,basis:'exact-id'}]:[...scored.values()].sort((a,b)=>b.score-a.score||a.memory.id.localeCompare(b.memory.id));
 let characters=2;const references=[];
 for(const hit of ranked){
  if(references.length>=limit)break;
  const record=recordIds.has(hit.memory.id)?records.find(r=>r.id===hit.memory.id):undefined;
  const reference={id:hit.memory.id,revision:record?.revision,kind:record?.kind??'memory',title:hit.memory.subject,sourceThreadId:hit.memory.sourceThreadId,sourceType:record?.source.type??'unspecified',scope:hit.memory.scope,project:hit.memory.project,basis:hit.basis,similarity:hit.similarity};
  const size=JSON.stringify(reference).length+(references.length?1:0);
  if(characters+size>maxChars)continue;
  references.push(reference);characters+=size;
 }
 return {action:references.length?'use-evidence':'expand-search',retrieval,references,characters,truncated:references.length<ranked.length,calibratedConfidence:null,controller:'local-typed-retrieval-v1',inference:semanticRuntimeStatus(file)};
}
