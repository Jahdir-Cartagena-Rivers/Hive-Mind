import {readHiveMind} from './core/store.ts';
import {BrainError} from './brain.mjs';
export async function memoryInsights(file,{projects=[],limit=20}={}) {
 if(!Array.isArray(projects)||!projects.every(p=>typeof p==='string')||!Number.isInteger(limit)||limit<1||limit>100)throw new BrainError(400,'Invalid insights request.');
 const key=s=>String(s??'').trim().toLowerCase().replace(/[\s_-]+/gu,'');
 const visible=r=>r.scope==='general'||projects.some(p=>key(p)===key(r.project));
 const all=(await readHiveMind(file)).continuity?.records??[];
 const records=all.filter(visible), byId=new Map(records.map(r=>[r.id,r]));
 const pairs=records.filter(r=>r.kind==='relation'&&['contradicts','resolved-by','outcome'].includes(r.data.relationship))
  .flatMap(r=>{const from=byId.get(r.data.from),to=byId.get(r.data.to);return from&&to?[{relation:r,from,to}]:[]});
 const contradictions=pairs.filter(p=>p.relation.data.relationship==='contradicts').map(p=>({...p,resolutions:pairs.filter(q=>q.relation.data.relationship==='resolved-by'&&q.from.id===p.relation.id).map(q=>q.to)}));
 const outcomes=pairs.filter(p=>p.relation.data.relationship==='outcome');
 const resurfaced=records.filter(r=>r.kind==='task'&&['open','active','blocked'].includes(r.data.status)).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)).slice(0,limit);
 return {contradictions:contradictions.slice(0,limit),outcomes:outcomes.slice(0,limit),resurfaced,interpretation:'Explicit links and task states; contradictions and outcomes are not inferred.'};
}
