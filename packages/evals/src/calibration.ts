import {agreement,labelMap,pairLabels} from './agreement.js';
import type {Labeled} from './agreement.js';
export interface HumanLabel extends Labeled {origin:'human';rater:string;rubricVersion:string;cohortHash:string;annotatedAt:string}
export function coverage(ids:string[],rows:Labeled[]){
 if(new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id.trim()))throw new Error('INVALID_EXPECTED_IDS');
 const map=labelMap(rows);if([...map.keys()].some(id=>!ids.includes(id)))throw new Error('UNEXPECTED_ID');
 const missing=ids.filter(id=>!map.has(id));return {expected:ids.length,labeled:map.size,missing,complete:missing.length===0};
}
export function validateAttribution(rows:HumanLabel[]|AttributedLabel[],ids:string[],cohortHash:string,rubricVersion:string,origin:'human'|'subagent',keys:readonly string[]){
 coverage(ids,rows);const raters=new Set<string>();
 const timestamp=origin==='human'?/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/:/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/;
 for(const row of rows){
  if(Object.keys(row).sort().join(',')!==[...keys].sort().join(',')||row.origin!==origin||typeof row.rater!=='string'||!row.rater.trim()||row.rater!==row.rater.trim()||row.rater.length>128||row.cohortHash!==cohortHash||row.rubricVersion!==rubricVersion||typeof row.annotatedAt!=='string'||!timestamp.test(row.annotatedAt)||!Number.isFinite(Date.parse(row.annotatedAt))||new Date(row.annotatedAt).toISOString().slice(0,19)!==row.annotatedAt.slice(0,19))throw new Error(origin==='human'?'INVALID_HUMAN_ATTESTATION':'INVALID_SUBAGENT_ATTRIBUTION');raters.add(row.rater);
 }
 if(raters.size>1)throw new Error('MIXED_RATERS');
}
export interface AttributedLabel extends Labeled {origin:'human'|'subagent';rater:string;rubricVersion:string;cohortHash:string;annotatedAt:string}
export const attributionKeys=['id','label','rater','origin','rubricVersion','cohortHash','annotatedAt'] as const;
export function validateHumanLabels(raw:unknown[],ids:string[],cohortHash:string,rubricVersion:string):HumanLabel[]{
 const rows=raw as HumanLabel[];validateAttribution(rows,ids,cohortHash,rubricVersion,'human',attributionKeys);return rows;
}
type VersionResult={coverage:ReturnType<typeof coverage>;agreement:ReturnType<typeof agreement>|null;reason:string|null};
/** Predeclared: all versions need complete identical IDs; highest defined kappa, lexical tie.
 * A single undefined version blocks selection rather than dropping a difficult comparator. */
export function compareLabels(ids:string[],reference:Labeled[],predictions:Record<string,Labeled[]>){
 const referenceCoverage=coverage(ids,reference),versions:Record<string,VersionResult>={};
 for(const version of Object.keys(predictions).sort()){
  const rows=predictions[version]!,covered=coverage(ids,rows);let result:ReturnType<typeof agreement>|null=null,reason:string|null=null;
  if(!referenceCoverage.complete||!covered.complete)reason='MISSING_COVERAGE';
  else{try{const paired=pairLabels(reference,rows);result=agreement(paired.a,paired.b);}catch(error){reason=(error as Error).message;}}
  versions[version]={coverage:covered,agreement:result,reason};
 }
 const candidates=Object.entries(versions);const ready=candidates.length>=2&&referenceCoverage.complete&&candidates.every(([,v])=>v.agreement!==null);
 candidates.sort((a,b)=>(b[1].agreement?.kappa??-Infinity)-(a[1].agreement?.kappa??-Infinity)||a[0].localeCompare(b[0]));
 return {referenceCoverage,versions,selected:ready?candidates[0]![0]:null,status:ready?'compared':'pending',selectionRule:'all versions complete and defined; highest ordinary kappa; lexical version tie; in-sample only'};
}

export function calibrate(ids:string[],humans:Labeled[],predictions:Record<string,Labeled[]>){const {referenceCoverage,...report}=compareLabels(ids,humans,predictions);return {humanCoverage:referenceCoverage,...report};}
