/** Trusted operator CLI only. CPU prepare is offline; run requires a separately admitted reservation. */
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,hash} from '../../../../packages/evals/src/judge.js';
import {readPrivate,writePrivate,replacePrivate,owned} from '../../../../packages/evals/src/task9Source.js';
import {runCommercialJudge} from '../../../../packages/evals/src/commercialJudge.js';
import type {CommercialEvent} from '../../../../packages/evals/src/commercialJudge.js';
import {prepareJudgeProfile} from '../../../../packages/models/src/azureJudgeProfile.js';
import {createAzureJudgeRoute} from '../../../../packages/models/src/azureCommercial.js';
import type {JudgeCommercialConfig} from '../../../../packages/models/src/azureCommercial.js';
import {configureTracing} from 'tracing/exporter';
import {createSpanSpool} from '../spool.js';
import {createRouter} from '../../../../packages/models/src/router.js';
function check(value:unknown,code:string):asserts value{if(!value)throw new Error(code);}
/** Persist charged-call evidence before any telemetry failure can terminate the loop. */
export function persistCommercialEvent(path:string,base:Record<string,unknown>,events:CommercialEvent[],event:CommercialEvent,spanExportFailed:boolean){
 events.push(event);replacePrivate(path,canonical({...base,status:event.state,spanExportFailed,events})+'\n');
 check(!spanExportFailed,'COMMERCIAL_SPAN_EXPORT_FAILED');
}
/** Explicit local exporter only: no OTLP/Langfuse/network fallback, append or file reuse. */
export function startCommercialTracing(path=process.env.KEEL_SPAN_FILE){
 check(typeof path==='string'&&path.length>0,'PRIVATE_COMMERCIAL_SPAN_FILE_REQUIRED');
 owned(dirname(resolve(path)),true);
 const spool=createSpanSpool(resolve(path),4_000_000,true);let failed=false;
 const trace=configureTracing({exporter:{
  export(spans,done){spool.export(spans,result=>{if(result.code!==0)failed=true;done(result);});},
  async forceFlush(){try{await spool.forceFlush?.();}catch{failed=true;throw new Error('COMMERCIAL_SPAN_EXPORT_FAILED');}},async shutdown(){try{await spool.shutdown();}catch{failed=true;throw new Error('COMMERCIAL_SPAN_EXPORT_FAILED');}}
 }});
 return {...trace,failed:()=>failed};
}
export async function main(args:string[]){
 const [command,...rest]=args;
 if(command==='prepare'){
  check(rest.length===2,'USAGE_PREPARE_PRIVATE_QUOTE_FILE_PRIVATE_BINDING_FILE');
  const quote=JSON.parse(readPrivate(resolve(rest[0]!),131072)) as {quote_id:string};
  const profile=prepareJudgeProfile(quote.quote_id,hash(canonical(quote)));writePrivate(resolve(rest[1]!),canonical(profile.binding)+'\n');
  console.log(JSON.stringify({status:'prepared-offline',phase:profile.binding.phase,logicalRequests:profile.binding.jobs.length,actualModelCalls:0}));return;
 }
 check(command==='run'&&rest.length===2,'USAGE_RUN_PRIVATE_CONFIG_FILE_PRIVATE_REPORT_FILE');
 const config=JSON.parse(readPrivate(resolve(rest[0]!),262144)) as JudgeCommercialConfig;
 check(Object.keys(config).sort().join(',')==='binding,inputPerMillion,keyFile,ledger,outputPerMillion,reservationId','INVALID_COMMERCIAL_CONFIG');
 const profile=prepareJudgeProfile(config.binding.quote_id,config.binding.quoteHash);
 check(canonical(profile.binding)===canonical(config.binding),'COMMERCIAL_PREPARED_SOURCE_OR_IMPLEMENTATION_DRIFT');
 const output=resolve(rest[1]!),pending=`${output}.pending`;check(!existsSync(output)&&!existsSync(pending),'COMMERCIAL_RUN_ALREADY_EXISTS');
 let tracing:ReturnType<typeof startCommercialTracing>|undefined;
 const events:CommercialEvent[]=[];
 const base={schema:1,binding:profile.binding,reservationId:config.reservationId,createdAt:new Date().toISOString()};
 writePrivate(pending,canonical({...base,status:'prepared',events})+'\n');
 try{
  tracing=startCommercialTracing();
  const route=await createAzureJudgeRoute(config),client=createRouter({azureJudge:route});
  const result=await runCommercialJudge({client,profile,pricing:route.pricing!,checkpoint:event=>{
   persistCommercialEvent(pending,base,events,event,tracing?.failed()??true);
  }});
  await tracing.forceFlush();check(!tracing.failed(),'COMMERCIAL_SPAN_EXPORT_FAILED');await tracing.shutdown();tracing=undefined;
  const report={...base,...result};writePrivate(output,canonical(report)+'\n');replacePrivate(pending,canonical({...base,status:result.status,events})+'\n');
  console.log(JSON.stringify({status:result.status,phase:config.binding.phase,physicalAttempts:result.physicalAttempts,logicalCompleted:result.logicalCompleted,invalidSchemaCount:result.invalidSchemaCount,reference_origin:'subagent',human_evidence:false,human_reference_gate_fulfilled:false}));
  if(result.status!=='completed')process.exitCode=1;
 }catch{
  replacePrivate(pending,canonical({...base,status:'failed; no resume',failure:'COMMERCIAL_RUN_FAILED',spanExportFailed:tracing?.failed()??false,events})+'\n');throw new Error('COMMERCIAL_RUN_FAILED_PRIVATE_EVIDENCE_RETAINED');
 }finally{if(tracing)try{await tracing.forceFlush();}finally{await tracing.shutdown();}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{
 console.error(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'COMMERCIAL_COMMAND_FAILED');process.exitCode=1;
});
