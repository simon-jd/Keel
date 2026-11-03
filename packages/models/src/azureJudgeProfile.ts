/** Frozen Task9 wire, shared by offline preparation and paid dispatch. */
import {readFileSync} from 'node:fs';
import {canonical,hash,prompts,RUBRIC} from '../../evals/src/judge.js';
import type {Sample} from '../../evals/src/judge.js';
import {AGENT_DIRECTORY,DIRECTORY,loadCohort,readAgentReference} from '../../evals/src/task9Source.js';
import {judgeIdentity} from './judgeIdentity.js';
import type {ChatRequest} from './types.js';
import {ModelError} from './protocol.js';
export const judgePolicy=JSON.parse(readFileSync(new URL('./task9-judge-policy.json',import.meta.url),'utf8')) as {
 phase:string;endpoint:string;deployment:string;model:string;version:string;region:string;sku:string;upgradePolicy:string;alias:string;cohortHash:string;referenceSourceHashes:{primary:string;secondary:string};rubricHash:string;promptHashes:{v1:string;v2:string};maxBodyBytes:number;wire:Record<string,unknown>;
};
export const judgeSerializerHash=hash(canonical(judgePolicy));
export type JudgeJob={logical:number;kind:'reproduce'|'judge';promptVersion:keyof typeof prompts;sampleId:string;requestHash:string};
export type JudgeBinding={phase:string;endpoint:string;deployment:string;model:string;version:string;region:string;sku:string;upgradePolicy:string;alias:string;quote_id:string;quoteHash:string;cohortHash:string;reference_origin:'subagent';human_evidence:false;human_reference_gate_fulfilled:false;referenceAuditHash:string;referenceSourceHashes:{primary:string;secondary:string};rubricHash:string;promptHashes:{v1:string;v2:string};serializerHash:string;gitSha:string;implementationSha256:string;jobs:JudgeJob[];wireHash:string};
function deny():never{throw new ModelError('invalid_request');}
export function judgeRequest(sample:Sample,version:keyof typeof prompts):ChatRequest{
 if(!Object.hasOwn(prompts,version))deny();
 return {model:'azureJudge',messages:[{role:'system',content:`${prompts[version]}\nRubric ${RUBRIC.version}: ${RUBRIC.text}`},{role:'user',content:canonical({input:sample.input,action:sample.action})}],temperature:0,seed:0,maxTokens:1024};
}
export function azureJudgeBody(req:ChatRequest):Record<string,unknown>{
 if(!req||Object.keys(req).sort().join(',')!=='maxTokens,messages,model,seed,temperature'||req.model!=='azureJudge'||req.seed!==0||req.temperature!==0||req.maxTokens!==1024||!Array.isArray(req.messages)||req.messages.length!==2)deny();
 for(const [i,m] of req.messages.entries())if(!m||Object.keys(m).sort().join(',')!=='content,role'||m.role!==(i===0?'system':'user')||typeof m.content!=='string')deny();
 if(!Object.values(prompts).some(p=>req.messages[0]!.content===`${p}\nRubric ${RUBRIC.version}: ${RUBRIC.text}`))deny();
 // Property order is part of the wire hash and matches the released feasibility serializer.
 const body={model:judgePolicy.deployment,messages:req.messages,stream:true,stream_options:{include_usage:true},n:1,max_completion_tokens:1024,temperature:0,seed:0,response_format:judgePolicy.wire.response_format};
 if(Buffer.byteLength(JSON.stringify(body),'utf8')>3072)deny();return body;
}
export function prepareJudgeProfile(quoteId:string,quoteHash:string,directory=DIRECTORY,sourceDirectory=AGENT_DIRECTORY){
 const cohort=loadCohort(directory),reference=readAgentReference(directory,sourceDirectory),identity=judgeIdentity();
 if(!quoteId||!/^[0-9a-f]{64}$/.test(quoteHash)||hash(canonical(RUBRIC))!==judgePolicy.rubricHash||canonical({v1:hash(prompts.v1),v2:hash(prompts.v2)})!==canonical(judgePolicy.promptHashes))throw new Error('TASK9_PROMPT_DRIFT');
 const ordered=[...Array.from({length:5},()=>({kind:'reproduce' as const,promptVersion:'v1' as const,sample:cohort.primary[0]!})),...(['v1','v2'] as const).flatMap(promptVersion=>cohort.primary.map(sample=>({kind:'judge' as const,promptVersion,sample})))];
 const requests=ordered.map(j=>judgeRequest(j.sample,j.promptVersion));
 const jobs=ordered.map((j,logical)=>({logical,kind:j.kind,promptVersion:j.promptVersion,sampleId:j.sample.id,requestHash:hash(JSON.stringify(azureJudgeBody(requests[logical]!)))}));
 const binding:JudgeBinding={phase:judgePolicy.phase,endpoint:judgePolicy.endpoint,deployment:judgePolicy.deployment,model:judgePolicy.model,version:judgePolicy.version,region:judgePolicy.region,sku:judgePolicy.sku,upgradePolicy:judgePolicy.upgradePolicy,alias:judgePolicy.alias,quote_id:quoteId,quoteHash,cohortHash:cohort.metadata.cohortHash,reference_origin:'subagent',human_evidence:false,human_reference_gate_fulfilled:false,referenceAuditHash:reference.auditHash,referenceSourceHashes:reference.summary.sourceHashes,rubricHash:hash(canonical(RUBRIC)),promptHashes:{v1:hash(prompts.v1),v2:hash(prompts.v2)},serializerHash:judgeSerializerHash,...identity,jobs,wireHash:hash(canonical(jobs))};
 return {binding,requests,cohort,reference};
}
