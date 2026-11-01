import {brainKinds} from './core/continuity.ts';
import {readHiveMind} from './core/store.ts';
import {BrainError} from './brain.mjs';

export const legacyRecordKinds=['task','preference','collection','artifact','episode','entity','relation','asset','client'];
/** Inspect compatibility without projecting, dropping or rewriting future records. */
export async function replicaCompatibility(file,{supportedRecordKinds=legacyRecordKinds,plannedRecordKinds=[]}={}) {
 for(const values of [supportedRecordKinds,plannedRecordKinds])if(!Array.isArray(values)||values.length>100||!values.every(v=>typeof v==='string'&&v.length<=80))throw new BrainError(400,'Invalid record-kind capability list.');
 const store=await readHiveMind(file);
 const requiredRecordKinds=[...new Set([...(store.continuity?.records??[]).map(r=>r.kind),...plannedRecordKinds])].sort();
 const unsupportedRecordKinds=requiredRecordKinds.filter(k=>!supportedRecordKinds.includes(k));
 return {supportedRecordKinds:[...brainKinds],requiredRecordKinds,unsupportedRecordKinds,compatible:unsupportedRecordKinds.length===0,upgradeRequired:unsupportedRecordKinds.length>0,minimumReaderVersion:requiredRecordKinds.some(k=>!legacyRecordKinds.includes(k))?'0.7.0':'0.6.0'};
}
