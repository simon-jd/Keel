/** Finite Task9 evaluator: every physical intent, raw response and invalid denominator survives. */
import {randomUUID} from 'node:crypto';
import {calibrateAgentReference,agentReferenceFlags} from './agentReference.js';
import {canonical,hash,parseVerdict,RUBRIC} from './judge.js';
import type {prompts,Verdict} from './judge.js';
import {judgeRequest} from '../../models/src/azureJudgeProfile.js';
import type {prepareJudgeProfile} from '../../models/src/azureJudgeProfile.js';
import type {CallAccounting,ChatChunk,ModelClient,Pricing,Usage,ProviderResponse} from '../../models/src/types.js';
type Profile=ReturnType<typeof prepareJudgeProfile>;
export type CommercialObservation={sampleId:string;sampleHash:string;promptVersion:keyof typeof prompts;promptHash:string;rubricHash:string;model:string;version:string;provider:'azureCommercial';seed:0;temperature:0;maxTokens:1024;rawResponseHash:string;semanticHash:string;action:{role:'assistant';content:string;toolCalls:[]};verdict:Verdict;usage:Usage;accounting:CallAccounting};
export type CommercialAttempt={physical:number;logical:number;intent:{runId:string;callId:string;sampleId:string;requestHash:string;preparedAt:string};outcome:'pending'|'valid'|'invalid-schema'|'failed';rawResponse:string|null;rawResponseBytes?:ProviderResponse['bytes'];rawResponseComplete?:boolean;httpStatus?:number;accounting:CallAccounting|null;usage:Usage|null;dispatch?:ProviderResponse['dispatch'];settlementStatus?:'validated'|'unknown';observation?:CommercialObservation;error?:string};
export type CommercialEvent={state:'dispatch-intent'|'settled';attempt:CommercialAttempt};
function check(value:unknown,code:string):asserts value{if(!value)throw new Error(code);}
export function validateCommercialAccounting(a:CallAccounting|undefined,usage:Usage|undefined,deployment:string,pricing:Pricing):asserts a is CallAccounting{
 check(a&&a.provider==='azureCommercial'&&a.model===deployment&&a.status==='success'&&a.costStatus==='known'&&a.attempts.length===1,'INVALID_COMMERCIAL_ACCOUNTING');
 const t=a.attempts[0]!;
 check(usage&&[usage.input,usage.output].every(n=>Number.isSafeInteger(n)&&n>=0)&&usage.input<=4096&&usage.output<=1024&&canonical(usage)===canonical(a.usage)&&canonical(usage)===canonical(t.usage)&&t.attempt===1&&t.outcome==='success'&&t.costStatus==='known','INVALID_COMMERCIAL_USAGE');
 const expected=(usage.input*pricing.inputPerMillion+usage.output*pricing.outputPerMillion)/1e6;
 check(Number.isFinite(expected)&&expected>=0&&a.costUsd===expected&&t.costUsd===expected,'INVALID_COMMERCIAL_COST');
}
export async function runCommercialJudge(options:{client:ModelClient;profile:Profile;pricing:Pricing;checkpoint:(event:CommercialEvent)=>void|Promise<void>}){
 const {client,profile,pricing}=options,b=profile.binding;
 check(b.phase==='task9-agent-judge-azure-mini-v1'&&b.jobs.length===605&&profile.cohort.primary.length===300,'FIXED_COMMERCIAL_COHORT_REQUIRED');
 const attempts:CommercialAttempt[]=[],observed:CommercialObservation[]=[];let logical=0,invalid=0,stopped=false;
 while(logical<605&&!stopped){
  const job=b.jobs[logical]!,sample=profile.cohort.primary.find(s=>s.id===job.sampleId);check(sample,'COMMERCIAL_SAMPLE_REQUIRED');
  const runId=randomUUID(),intent={runId,callId:`${runId}:1`,sampleId:job.sampleId,requestHash:job.requestHash,preparedAt:new Date().toISOString()};
  const a:CommercialAttempt={physical:attempts.length+1,logical,intent,outcome:'pending',rawResponse:null,accounting:null,usage:null};
  attempts.push(a);await options.checkpoint({state:'dispatch-intent',attempt:structuredClone(a)});
  let result:ChatChunk|undefined;
  try{
   for await(const chunk of client.stream(judgeRequest(sample,job.promptVersion),{signal:AbortSignal.timeout(160000),run_id:intent.runId,call_id:intent.callId,commercialLogical:logical})){
    check(result===undefined,'MULTIPLE_COMMERCIAL_RESULTS');result=chunk;
   }
   check(result,'EMPTY_COMMERCIAL_RESULT');
   a.rawResponse=result.providerResponse?.raw??null;a.accounting=result.accounting??null;a.usage=result.usage??null;
   if(result.providerResponse?.bytes)a.rawResponseBytes=result.providerResponse.bytes;
   if(result.providerResponse?.complete!==undefined)a.rawResponseComplete=result.providerResponse.complete;
   if(result.providerResponse?.httpStatus!==undefined)a.httpStatus=result.providerResponse.httpStatus;
   if(result.providerResponse?.dispatch)a.dispatch=result.providerResponse.dispatch;
   if(result.providerResponse?.settlementStatus)a.settlementStatus=result.providerResponse.settlementStatus;
   validateCommercialAccounting(result.accounting,result.usage,b.deployment,pricing);
   check(a.rawResponse!==null&&a.rawResponseComplete===true,'COMPLETE_RAW_COMMERCIAL_RESPONSE_REQUIRED');
   check(a.settlementStatus==='validated','VALIDATED_COMMERCIAL_SETTLEMENT_REQUIRED');
   check(a.dispatch&&Number.isFinite(a.dispatch.startedAtMonotonicMs)&&(attempts.length===1?a.dispatch.intervalMs===null:typeof a.dispatch.intervalMs==='number'&&a.dispatch.intervalMs>=4000),'COMMERCIAL_PACING_REQUIRED');
   check(!result.toolCalls?.length&&!result.invalidToolCalls?.length,'INVALID_COMMERCIAL_ACTION');
   let verdict:Verdict;
   try{verdict=parseVerdict(result.text??'');}catch{a.outcome='invalid-schema';a.error='INVALID_JUDGE_SCHEMA';invalid++;if(logical<5||invalid>20||attempts.length>=625)stopped=true;continue;}
   const action={role:'assistant' as const,content:result.text!,toolCalls:[] as []};
   const req=judgeRequest(sample,job.promptVersion);
   a.observation={sampleId:sample.id,sampleHash:hash(canonical(sample)),promptVersion:job.promptVersion,promptHash:hash(req.messages[0]!.content),rubricHash:hash(canonical(RUBRIC)),model:b.model,version:b.version,provider:'azureCommercial',seed:0,temperature:0,maxTokens:1024,rawResponseHash:hash(a.rawResponse),semanticHash:hash(canonical({action,verdict})),action,verdict,usage:result.usage!,accounting:result.accounting};
   a.outcome='valid';observed.push(a.observation);logical++;
  }catch(error){
   const e=error as {code?:string;message?:string;providerResponse?:ProviderResponse;accounting?:CallAccounting;judgeOutcome?:string};
   a.rawResponse??=e.providerResponse?.raw??null;a.accounting??=e.accounting??null;a.usage??=e.accounting?.usage??e.accounting?.attempts[0]?.usage??null;
   if(e.providerResponse?.bytes)a.rawResponseBytes=e.providerResponse.bytes;
   if(e.providerResponse?.complete!==undefined)a.rawResponseComplete=e.providerResponse.complete;
   if(e.providerResponse?.httpStatus!==undefined)a.httpStatus=e.providerResponse.httpStatus;
   if(e.providerResponse?.dispatch)a.dispatch=e.providerResponse.dispatch;
   if(e.providerResponse?.settlementStatus)a.settlementStatus=e.providerResponse.settlementStatus;
   a.outcome=e.judgeOutcome==='invalid-schema'?'invalid-schema':'failed';if(a.outcome==='invalid-schema')invalid++;
   a.error=typeof e.code==='string'?e.code:typeof e.message==='string'&&/^[A-Z_]+$/.test(e.message)?e.message:'COMMERCIAL_CALL_FAILED';stopped=true;
  }finally{await options.checkpoint({state:'settled',attempt:structuredClone(a)});}
  if(attempts.length>=625&&logical<605)stopped=true;
 }
 const complete=logical===605&&!stopped,repro=observed.slice(0,5);
 const reproduction=repro.length===5?{scope:'five original same-input Azure commercial requests; not universal determinism',canonicalization:'complete assistant action and parsed verdict; transport IDs/timing/accounting excluded; no rationale truncation',rawEqual:repro.every(r=>r.rawResponseHash===repro[0]!.rawResponseHash),semanticEqual:repro.every(r=>r.semanticHash===repro[0]!.semanticHash),verdictsEqual:repro.every(r=>canonical(r.verdict)===canonical(repro[0]!.verdict)),labelsEqual:repro.every(r=>r.verdict.label===repro[0]!.verdict.label),runs:repro}:null;
 const predictions={v1:observed.slice(5,305).map(r=>({id:r.sampleId,label:r.verdict.label})),v2:observed.slice(305,605).map(r=>({id:r.sampleId,label:r.verdict.label}))};
 const knownCostUsd=attempts.reduce((sum,a)=>sum+(typeof a.accounting?.costUsd==='number'&&Number.isFinite(a.accounting.costUsd)&&a.accounting.costUsd>=0?a.accounting.costUsd:0),0),costStatus=attempts.some(a=>!a.accounting||a.accounting.costStatus!=='known'||!a.usage||a.settlementStatus!=='validated')?'unknown':'known';
 const physicalCounts=attempts.map(a=>Array.isArray(a.accounting?.attempts)?a.accounting.attempts.length:null);
 const physicalAttempts=physicalCounts.some(n=>n===null)?null:physicalCounts.reduce<number>((sum,n)=>sum+(n??0),0);
 const intervals=attempts.flatMap(a=>typeof a.dispatch?.intervalMs==='number'?[a.dispatch.intervalMs]:[]);
 return {schema:1,...agentReferenceFlags,accepted_user_substitution:true,referenceSummary:profile.reference.summary,binding:b,status:complete?'completed':'failed',intentsAttempted:attempts.length,physicalAttempts,logicalCompleted:logical,invalidSchemaCount:invalid,invalidSchemaRate:physicalAttempts?invalid/physicalAttempts:null,pacing:{minimumStartIntervalMs:4000,observedMinimumIntervalMs:intervals.length?Math.min(...intervals):null},knownCostUsd,costStatus,attempts,reproduction,predictions,calibration:complete?calibrateAgentReference(profile.cohort.metadata.primaryIds,profile.reference.primary,predictions):null};
}
