/** Explicit weak subagent references; never converted to human annotations. */
import {agreement,pairLabels} from './agreement.js';
import type {Labeled} from './agreement.js';
import {attributionKeys,compareLabels,coverage,validateAttribution} from './calibration.js';
import type {AttributedLabel} from './calibration.js';
export interface AgentLabel extends AttributedLabel {origin:'subagent';rationale:string;confidence:'low'|'medium'|'high';inputSha256:string}
export const agentReferenceFlags={reference_origin:'subagent',human_evidence:false,human_reference_gate_fulfilled:false} as const;
export function validateAgentLabels(raw:unknown[],ids:string[],cohortHash:string,rubricVersion:string,inputHashes:ReadonlyMap<string,string>):AgentLabel[]{
 const rows=raw as AgentLabel[];validateAttribution(rows,ids,cohortHash,rubricVersion,'subagent',[...attributionKeys,'rationale','confidence','inputSha256']);
 for(const row of rows)if(typeof row.rationale!=='string'||!row.rationale.trim()||row.rationale.length>32768||!['low','medium','high'].includes(row.confidence)||!/^[0-9a-f]{64}$/.test(row.inputSha256)||row.inputSha256!==inputHashes.get(row.id))throw new Error('INVALID_SUBAGENT_REFERENCE');
 return rows;
}
export function agentReferenceReport(primaryIds:string[],secondaryIds:string[],primary:AgentLabel[],secondary:AgentLabel[]){
 if([...primary,...secondary].some(r=>r.origin!=='subagent'))throw new Error('SUBAGENT_REFERENCE_REQUIRED');
 const primaryCoverage=coverage(primaryIds,primary),secondaryCoverage=coverage(secondaryIds,secondary),subset=primary.filter(r=>secondaryIds.includes(r.id));
 if(new Set(secondaryIds).size!==secondaryIds.length||secondaryIds.some(id=>!primaryIds.includes(id)))throw new Error('SECONDARY_NOT_SUBSET');
 if(primary.length&&secondary.length&&primary[0]!.rater===secondary[0]!.rater)throw new Error('DISTINCT_SUBAGENT_RATERS_REQUIRED');
 let result:ReturnType<typeof agreement>|null=null,agreementReason:string|null='MISSING_REFERENCE_COVERAGE';
 if(subset.length===secondaryIds.length&&secondaryCoverage.complete){try{const pairs=pairLabels(subset,secondary);result=agreement(pairs.a,pairs.b);agreementReason=null;}catch(error){agreementReason=(error as Error).message;}}
 return {...agentReferenceFlags,accepted_user_substitution:primaryCoverage.complete&&secondaryCoverage.complete,primaryCoverage,secondaryCoverage,agreement:result,agreementReason,limitations:'AI-AI consistency only; same model family in isolated sessions, no statistical independence, gold correctness or accuracy claim; nonblind adjudications excluded'};
}
export function calibrateAgentReference(ids:string[],reference:AgentLabel[],predictions:Record<string,Labeled[]>){
 if(reference.some(r=>r.origin!=='subagent'))throw new Error('SUBAGENT_REFERENCE_REQUIRED');
 return {...agentReferenceFlags,...compareLabels(ids,reference,predictions),scope:'in-sample judge agreement with attributed weak subagent reference; not human or gold accuracy'};
}
