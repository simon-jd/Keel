/** Human annotation CLI. No model/service lifecycle, provider routes or paid dispatch.
 * Run via tsx services/api/src/routes/label.ts; fixed private workspace destination.
 */
import {existsSync,mkdirSync,readdirSync,rmdirSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {agreement,pairLabels} from '../../../../packages/evals/src/agreement.js';
import {agentReferenceFlags,calibrateAgentReference} from '../../../../packages/evals/src/agentReference.js';
import {calibrate,coverage,validateHumanLabels} from '../../../../packages/evals/src/calibration.js';
import type {HumanLabel} from '../../../../packages/evals/src/calibration.js';
import {canonical,createJudge,hash,JudgeFailure,observeWithIntent,parseVerdict,prompts,reproduce,RUBRIC,validLocalJudgeObservation} from '../../../../packages/evals/src/judge.js';
import type {IntentEvent,Sample} from '../../../../packages/evals/src/judge.js';
import {ROOT,DIRECTORY,AGENT_DIRECTORY,loadCohort,readAgentReference,importAgentReference,requireValue,owned,syncDirectory,writePrivate,replacePrivate,readPrivate,readSecret,rows,serialize,role} from '../../../../packages/evals/src/task9Source.js';
import type {Role} from '../../../../packages/evals/src/task9Source.js';
import {localJudgeIdentityFromEnvironment,LOCAL_JUDGE_PROFILE_V2,validateLocalJudgeIdentity} from 'models/localJudgeProfile';
import type {LocalJudgeIdentity} from 'models/localJudgeProfile';
import {verifyJudgeApiProfile} from '../../../../packages/evals/src/localJudgeProtocol.js';
export {FROZEN_COHORT_HASH,loadCohort,readAgentReference,importAgentReference,registerFixtureWorkspaceForTests,readPrivate,writePrivate,readSecret} from '../../../../packages/evals/src/task9Source.js';
function imports(directory:string){const path=join(directory,'imports');if(!existsSync(path))return [];owned(path,true);return readdirSync(path).sort().map(name=>{requireValue(/^\d{6}$/.test(name),'IMPORT_DIRECTORY');const directory=join(path,name);owned(directory,true);return directory;});}
function auditSnapshot(directory:string,which:Role){
 const cohort=loadCohort(directory);let expected=hash('');
 for(const transaction of imports(directory)){
  const recordText=readPrivate(join(transaction,'record.json'));const record=JSON.parse(recordText) as {role:Role;beforeHash:string;afterHash:string;cohortHash:string;submittedHash:string};
  role(record.role);requireValue(record.cohortHash===cohort.metadata.cohortHash&&hash(readPrivate(join(transaction,'submitted.jsonl')))===record.submittedHash,'IMPORT_SOURCE_BINDING');
  requireValue(existsSync(join(transaction,'complete.json')),'IMPORT_PENDING_RUN_RECOVER');requireValue(JSON.parse(readPrivate(join(transaction,'complete.json'))).recordHash===hash(recordText),'IMPORT_MARKER');
  requireValue(hash(readPrivate(join(transaction,'labels.jsonl')))===record.afterHash,'IMPORT_AFTER_HASH');
  if(record.role===which){requireValue(record.beforeHash===expected,'IMPORT_CHAIN');expected=record.afterHash;}
 }
 return expected;
}
export function readLabels(directory:string,which:Role):HumanLabel[]{
 const cohort=loadCohort(directory),text=readPrivate(join(directory,`${which}.labels.jsonl`));
 requireValue(hash(text)===auditSnapshot(directory,which),'LABEL_AUDIT_MISMATCH');return validateHumanLabels(rows(text),cohort.metadata[which==='primary'?'primaryIds':'secondaryIds'],cohort.metadata.cohortHash,RUBRIC.version);
}
function withLock<T>(directory:string,fn:()=>T):T{
 const lock=join(directory,'.label-lock');mkdirSync(lock,{mode:0o700});try{return fn();}finally{rmdirSync(lock);}
}
export function importLabels(directory:string,which:Role,input:unknown[]){loadCohort(directory);return withLock(directory,()=>{
 const cohort=loadCohort(directory),ids=cohort.metadata[which==='primary'?'primaryIds':'secondaryIds'];
 const submitted=validateHumanLabels(input,ids,cohort.metadata.cohortHash,RUBRIC.version);
 requireValue(submitted.length>0,'EMPTY_IMPORT');const prior=readLabels(directory,which),other=readLabels(directory,which==='primary'?'secondary':'primary');
 const merged=new Map(prior.map(r=>[r.id,r]));
 for(const label of submitted){const existing=merged.get(label.id);requireValue(!existing||canonical(existing)===canonical(label),'RELABEL_REQUIRES_NEW_COHORT');merged.set(label.id,label);}
 const next=validateHumanLabels([...merged.values()],ids,cohort.metadata.cohortHash,RUBRIC.version);
 requireValue(!other.length||!next.length||other[0]!.rater!==next[0]!.rater,'SECOND_RATER_MUST_BE_INDEPENDENT');
 const base=join(directory,'imports');if(!existsSync(base)){mkdirSync(base,{mode:0o700});syncDirectory(directory);}owned(base,true);
 const transaction=String(imports(directory).length+1).padStart(6,'0'),path=join(base,transaction);mkdirSync(path,{mode:0o700});syncDirectory(base);
 const before=readPrivate(join(directory,`${which}.labels.jsonl`)),after=serialize(next),source=serialize(submitted);
 const record={schema:1,role:which,cohortHash:cohort.metadata.cohortHash,origin:'human-self-attested',rater:next[0]!.rater,beforeHash:hash(before),afterHash:hash(after),submittedHash:hash(source),submitted:submitted.length,total:next.length,at:new Date().toISOString()};
 const recordText=canonical(record)+'\n';writePrivate(join(path,'submitted.jsonl'),source);writePrivate(join(path,'labels.jsonl'),after);writePrivate(join(path,'record.json'),recordText);
 replacePrivate(join(directory,`${which}.labels.jsonl`),after);writePrivate(join(path,'complete.json'),canonical({recordHash:hash(recordText)})+'\n');
 return {...coverage(ids,next),transaction};
 });}
export function recoverImport(directory:string){loadCohort(directory);return withLock(directory,()=>{
 const transactions=imports(directory),pending=transactions.filter(p=>!existsSync(join(p,'complete.json')));
 requireValue(pending.length===1&&pending[0]===transactions.at(-1),'ONE_FINAL_PENDING_TRANSACTION_REQUIRED');
 const path=pending[0]!,recordText=readPrivate(join(path,'record.json')),record=JSON.parse(recordText),which=role(record.role),cohort=loadCohort(directory);
 const before=readPrivate(join(directory,`${which}.labels.jsonl`)),after=readPrivate(join(path,'labels.jsonl'));
 requireValue([record.beforeHash,record.afterHash].includes(hash(before))&&hash(after)===record.afterHash&&record.cohortHash===cohort.metadata.cohortHash&&hash(readPrivate(join(path,'submitted.jsonl')))===record.submittedHash,'UNRECOVERABLE_IMPORT');
 validateHumanLabels(rows(after),cohort.metadata[which==='primary'?'primaryIds':'secondaryIds'],cohort.metadata.cohortHash,RUBRIC.version);
 replacePrivate(join(directory,`${which}.labels.jsonl`),after);writePrivate(join(path,'complete.json'),canonical({recordHash:hash(recordText)})+'\n');return {recovered:relative(directory,path)};
});}
function coverageReport(directory:string){
 const cohort=loadCohort(directory),primary=readLabels(directory,'primary'),secondary=readLabels(directory,'secondary');
 const subset=primary.filter(r=>cohort.metadata.secondaryIds.includes(r.id));let interRater:ReturnType<typeof agreement>|null=null,reason='MISSING_HUMAN_COVERAGE';
 if(subset.length===cohort.metadata.secondaryIds.length&&secondary.length===subset.length){requireValue(primary[0]?.rater!==secondary[0]?.rater,'SECOND_RATER_MUST_BE_INDEPENDENT');try{const paired=pairLabels(subset,secondary);interRater=agreement(paired.a,paired.b);reason='';}catch(error){reason=(error as Error).message;}}
 return {cohortHash:cohort.metadata.cohortHash,primary:coverage(cohort.metadata.primaryIds,primary),secondary:coverage(cohort.metadata.secondaryIds,secondary),interRater,interRaterReason:reason||null};
}
export function admitJudgeReference(raw:unknown,reference:ReturnType<typeof readAgentReference>|null){
 const value=raw as Record<string,unknown>;
 if(reference)requireValue(value.reference_origin==='subagent'&&value.human_evidence===false&&value.human_reference_gate_fulfilled===false&&value.accepted_user_substitution===true&&value.referenceAuditHash===reference.auditHash&&canonical(value.referenceSourceHashes)===canonical(reference.summary.sourceHashes),'JUDGE_REFERENCE_SOURCE_MISMATCH');
 else requireValue(value.reference_origin===undefined||value.reference_origin==='human','HUMAN_CALIBRATION_REJECTS_AGENT_RUN');
}
function implementation(){
 const result=spawnSync(join(ROOT,'.tools/bench-venv/bin/python'),['-c',"import sys,json;sys.path.insert(0,'services/bench-adapters');from provenance import execution_identity;x=execution_identity();print(json.dumps({'gitSha':x['git_sha'],'implementationSha256':x['implementation']['sha256']}))"],{cwd:ROOT,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',maxBuffer:4096});
 requireValue(result.status===0,'CLEAN_IMPLEMENTATION_REQUIRED');return JSON.parse(result.stdout);
}
function version(value:string|undefined):keyof typeof prompts{requireValue(value==='v1'||value==='v2','PROMPT_VERSION_REQUIRED');return value;}
function runName(value:string|undefined){requireValue(value&&/^[a-zA-Z0-9_-]{1,64}$/.test(value),'RUN_NAME_REQUIRED');return value;}
export function admitModelReference(command:'reproduce'|'judge',origin:'human'|'subagent',directory=DIRECTORY,sourceDirectory=AGENT_DIRECTORY){
 const cohort=loadCohort(directory);
 if(origin==='subagent')return readAgentReference(directory,sourceDirectory);
 if(command==='judge')requireValue(coverage(cohort.metadata.primaryIds,readLabels(directory,'primary')).complete,'HUMAN_PRIMARY_COVERAGE_REQUIRED_BEFORE_BULK');
 return null;
}
/** Preserve historical v1 filenames; v2 never writes into that experiment namespace. */
export function judgeRunPrefix(agentMode:boolean,profile?:LocalJudgeIdentity):string {
 const local=profile===undefined?'':validateLocalJudgeIdentity(profile).profile===LOCAL_JUDGE_PROFILE_V2?'local-json-schema-v2-':'local-json-schema-';
 return `${agentMode?'agent-':''}${local}`;
}
async function modelRun(command:'reproduce'|'judge',args:string[],agentMode=false,localProfileMode=false){
 requireValue(args.length===3,'USAGE_MODEL_COMMAND_PROMPT_TOKEN_FILE_RUN_NAME');
 const localJudgeProfile=localProfileMode?localJudgeIdentityFromEnvironment(process.env):undefined;
 requireValue(!localProfileMode||localJudgeProfile!==undefined,'LOCAL_JUDGE_PROFILE_CONFIGURATION_REQUIRED');
 const promptVersion=version(args[0]),name=runName(args[2]),cohort=loadCohort(),prefix=judgeRunPrefix(agentMode,localJudgeProfile),output=join(DIRECTORY,`${prefix}${command}-${name}.json`),pending=join(DIRECTORY,`${prefix}${command}-${name}.pending.json`);
 const reference=admitModelReference(command,agentMode?'subagent':'human');
 requireValue(!existsSync(output)&&!existsSync(pending),'RUN_NAME_ALREADY_USED');
 const identity=implementation(),token=readSecret(args[1]!),judge=createJudge({token,promptVersion,...(localJudgeProfile===undefined?{}:{localJudgeProfile})});
 // Verify before creating a run/checkpoint or allowing the first model dispatch.
 if(localJudgeProfile)await judge.verifyProfile();else await verifyJudgeApiProfile('http://127.0.0.1:18080/v1/agent/step',token,fetch);
 const referenceProvenance=reference?{...agentReferenceFlags,accepted_user_substitution:reference.summary.accepted_user_substitution,referenceAuditHash:reference.auditHash,referenceSourceHashes:reference.summary.sourceHashes,referenceAttribution:reference.summary.sourceAttribution}:{};
 const provenance={schema:localJudgeProfile?2:1,...(localJudgeProfile?{localJudgeProfile}:{}),...referenceProvenance,cohortHash:cohort.metadata.cohortHash,rubric:RUBRIC,rubricHash:hash(canonical(RUBRIC)),promptVersion,promptText:prompts[promptVersion],promptHash:hash(prompts[promptVersion]),...identity,endpoint:'http://127.0.0.1:18080/v1/agent/step',requestedModel:'local',resolvedModel:'see validated per-call accounting; unknown if absent',seed:0,temperature:0,maxTokens:1024,createdAt:new Date().toISOString()};
 const observed:Awaited<ReturnType<typeof judge.observe>>[]=[];let requests=0;let failure:unknown=null;const intents:IntentEvent[]=[];
 const checkpoint=(status:string)=>replacePrivate(pending,canonical({...provenance,status,requestsAttempted:requests,completed:observed.length,unresolvedRequests:requests-observed.length,observed,failure,intents})+'\n');
 writePrivate(pending,canonical({...provenance,status:'prepared',requestsAttempted:0,observed:[],intents:[]})+'\n');
 const wrapped={...judge,observe:async(sample:Sample,rubric:{version:string;text:string})=>{const result=await observeWithIntent(judge,sample,rubric,event=>{if(event.state==='dispatch-intent')requests++;intents.push(event);checkpoint(event.state);});observed.push(result);checkpoint('running');return result;}};
 try{
  let result:unknown;if(command==='reproduce')result=await reproduce(wrapped,cohort.primary[0]!,RUBRIC);
  else{for(const sample of cohort.primary)await wrapped.observe(sample,RUBRIC);result={scope:'BFCL selected cohort only',predictions:cohort.primary.map((s,i)=>({id:s.id,label:observed[i]!.verdict.label})),observed};}
  const value={...provenance,status:'completed',requestsAttempted:requests,completed:observed.length,intents,result};writePrivate(output,canonical(value)+'\n');checkpoint('completed');
  console.log(JSON.stringify({...(reference?{...agentReferenceFlags,accepted_user_substitution:true}:{}),status:'completed',output:relative(ROOT,output),requestsAttempted:requests,semanticEqual:command==='reproduce'?(result as {semanticEqual:boolean}).semanticEqual:undefined}));
 }catch(error){failure=error instanceof JudgeFailure?{code:error.code,...error.evidence}:{code:'JUDGE_CALL_FAILED',accounting:null,usage:null,rawResponseHash:null};checkpoint('failed; validated failure accounting retained; absent accounting remains unknown');throw new Error('MODEL_RUN_FAILED_PRIVATE_PENDING_EVIDENCE_RETAINED');}
}
async function annotate(which:Role,rater:string){
 requireValue(rater&&rater.trim()===rater&&rater.length<=128,'HUMAN_RATER_ID_REQUIRED');const cohort=loadCohort(),samples=cohort[which];
 requireValue(process.stdin.isTTY&&process.stdout.isTTY,'HUMAN_INTERACTIVE_TTY_REQUIRED');
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{const answer=await rl.question('I am a human rater, making my own labels without machine verdicts or other rater labels (type HUMAN): ');requireValue(answer==='HUMAN','HUMAN_ATTESTATION_REQUIRED');
  console.log(`Rubric ${RUBRIC.version}: ${RUBRIC.text}`);
  for(const sample of samples){if(readLabels(DIRECTORY,which).some(r=>r.id===sample.id))continue;
   console.log(JSON.stringify(sample,null,2));const label=await rl.question('pass / fail / skip / quit: ');if(label==='quit')break;if(label==='skip')continue;if(label!=='pass'&&label!=='fail')throw new Error('INVALID_HUMAN_LABEL');
   importLabels(DIRECTORY,which,[{id:sample.id,label,rater,origin:'human',rubricVersion:RUBRIC.version,cohortHash:cohort.metadata.cohortHash,annotatedAt:new Date().toISOString()}]);
  }
 }finally{rl.close();}
}
type StoredJudgeRun={schema:number;localJudgeProfile?:LocalJudgeIdentity;status:string;cohortHash:string;rubricHash:string;promptVersion:string;promptHash:string;seed:number;temperature:number;maxTokens:number;requestedModel:string;implementationSha256:string;gitSha:string;requestsAttempted:number;completed:number;result:{predictions:{id:string;label:string}[];observed:Awaited<ReturnType<ReturnType<typeof createJudge>['observe']>>[]}};
export function admitJudgeRun(raw:unknown,cohort:ReturnType<typeof loadCohort>){
 const value=raw as StoredJudgeRun,v=version(value?.promptVersion);
 const localJudgeProfile=value.schema===2?validateLocalJudgeIdentity(value.localJudgeProfile):undefined;
 requireValue(((value.schema===1&&value.localJudgeProfile===undefined)||value.schema===2)&&value.status==='completed'&&value.cohortHash===cohort.metadata.cohortHash&&value.rubricHash===hash(canonical(RUBRIC))&&value.promptHash===hash(prompts[v])&&value.seed===0&&value.temperature===0&&value.maxTokens===1024&&value.requestedModel==='local'&&/^[0-9a-f]{64}$/.test(value.implementationSha256??'')&&/^[0-9a-f]{40}$/.test(value.gitSha??'')&&value.requestsAttempted===cohort.primary.length&&value.completed===cohort.primary.length&&Array.isArray(value.result?.predictions)&&Array.isArray(value.result?.observed),'JUDGE_PROVENANCE_MISMATCH');
 requireValue(coverage(cohort.metadata.primaryIds,value.result.predictions).complete,'JUDGE_COVERAGE_MISMATCH');
 requireValue(value.result.observed.length===cohort.primary.length&&value.result.observed.every((r,i)=>{
  if(!r||r.sampleId!==cohort.primary[i]?.id||r.sampleHash!==hash(canonical(cohort.primary[i]))||r.promptVersion!==v||r.rubricHash!==hash(canonical(RUBRIC))||r.promptHash!==hash(`${prompts[v]}\nRubric ${RUBRIC.version}: ${RUBRIC.text}`)||r.seed!==0||r.temperature!==0||r.maxTokens!==1024||!r.action||r.action.role!=='assistant'||!Array.isArray(r.action.toolCalls)||r.action.toolCalls.length||typeof r.action.content!=='string'||!/^[0-9a-f]{64}$/.test(r.rawResponseHash))return false;
  if(localJudgeProfile===undefined?r.localJudgeProfile!==undefined:!validLocalJudgeObservation(r,localJudgeProfile))return false;
  const verdict=parseVerdict(r.action.content);
  return canonical(verdict)===canonical(r.verdict)&&r.semanticHash===hash(canonical({action:r.action,verdict:r.verdict}))&&r.verdict.label===value.result.predictions[i]?.label&&value.result.predictions[i]?.id===cohort.primary[i]?.id;
 }),'JUDGE_PREDICTION_BINDING');
 const models=new Set(value.result.observed.map(r=>r.accounting?.model));requireValue(models.size===1&&[...models].every(m=>typeof m==='string'&&m.length>0),'KNOWN_SAME_MODEL_REQUIRED');
 return {version:v,predictions:value.result.predictions,model:[...models][0]!,implementation:value.implementationSha256,protocol:localJudgeProfile?hash(canonical(localJudgeProfile)):'legacy-local-prompt-json-v1',localJudgeProfile:localJudgeProfile??null};
}
export function admitJudgeComparison(prior:ReturnType<typeof admitJudgeRun>|undefined,next:ReturnType<typeof admitJudgeRun>){
 requireValue(!prior||(prior.model===next.model&&prior.implementation===next.implementation),'COMPARISON_MODEL_OR_IMPLEMENTATION_DRIFT');
 requireValue(!prior||prior.protocol===next.protocol,'COMPARISON_LOCAL_JUDGE_PROTOCOL_DRIFT');return next;
}
export async function main(args:string[]){
 const [command,...rest]=args;
 if(command==='protocol'){requireValue(rest.length===0,'USAGE_PROTOCOL');console.log(canonical({rubric:RUBRIC,rubricHash:hash(canonical(RUBRIC)),promptHashes:{v1:hash(prompts.v1),v2:hash(prompts.v2)}}));}
 else if(command==='agent-import'){requireValue(rest.length===0,'USAGE_AGENT_IMPORT');console.log(canonical(importAgentReference()));}
 else if(command==='agent-coverage'){requireValue(rest.length===0,'USAGE_AGENT_COVERAGE');console.log(canonical(readAgentReference().summary));}
 else if(command==='coverage'){requireValue(rest.length===0,'USAGE_COVERAGE');console.log(JSON.stringify(coverageReport(DIRECTORY)));}
 else if(command==='recover'){requireValue(rest.length===0,'USAGE_RECOVER');console.log(JSON.stringify(recoverImport(DIRECTORY)));}
 else if(command==='import'){
  requireValue(rest.length===2,'USAGE_IMPORT_ROLE_PRIVATE_FILE');const which=role(rest[0]),path=resolve(rest[1]!);requireValue(path.startsWith(DIRECTORY+'/'),'IMPORT_FILE_MUST_BE_IN_PRIVATE_COHORT_DIRECTORY');console.log(JSON.stringify(importLabels(DIRECTORY,which,rows(readPrivate(path)))));
 }else if(command==='annotate'){requireValue(rest.length===2,'USAGE_ANNOTATE_ROLE_RATER_ID');await annotate(role(rest[0]),rest[1]!);}
 else if(command==='reproduce'||command==='judge')await modelRun(command,rest);
 else if(command==='agent-reproduce'||command==='agent-judge')await modelRun(command==='agent-judge'?'judge':'reproduce',rest,true);
 else if(command==='local-reproduce'||command==='local-judge')await modelRun(command==='local-judge'?'judge':'reproduce',rest,false,true);
 else if(command==='agent-local-reproduce'||command==='agent-local-judge')await modelRun(command==='agent-local-judge'?'judge':'reproduce',rest,true,true);
 else if(command==='calibrate'||command==='agent-calibrate'){
  requireValue(rest.length>=1&&rest.length<=3,'USAGE_CALIBRATE_RUN_NAME_OPTIONAL_JUDGE_FILES');const name=runName(rest[0]),cohort=loadCohort(),reference=command==='agent-calibrate'?readAgentReference():null,predictions:Record<string,{id:string;label:string}[]>={v1:[],v2:[]},sourceHashes:Record<string,string>={};let compared:ReturnType<typeof admitJudgeRun>|undefined;
  for(const file of rest.slice(1)){
   const path=resolve(file);requireValue(path.startsWith(DIRECTORY+'/'),'PRIVATE_JUDGE_FILE_REQUIRED');const text=readPrivate(path),value=JSON.parse(text);
   admitJudgeReference(value,reference);const admitted=admitJudgeRun(value,cohort),v=admitted.version;requireValue(!Object.hasOwn(sourceHashes,v),'DUPLICATE_PROMPT_VERSION');
   compared=admitJudgeComparison(compared,admitted);
   predictions[v]=admitted.predictions;sourceHashes[v]=hash(text);
  }
  const report={...(reference?reference.summary:coverageReport(DIRECTORY)),comparedModel:compared?.model??null,comparedImplementation:compared?.implementation??null,comparedProtocol:compared?.protocol??null,localJudgeProfile:compared?.localJudgeProfile??null,rubricHash:hash(canonical(RUBRIC)),judgeSourceHashes:sourceHashes,calibration:reference?calibrateAgentReference(cohort.metadata.primaryIds,reference.primary,predictions):calibrate(cohort.metadata.primaryIds,readLabels(DIRECTORY,'primary'),predictions)};
  writePrivate(join(DIRECTORY,`${reference?'agent-':''}calibration-${name}.json`),canonical(report)+'\n');console.log(JSON.stringify({...(reference?{...agentReferenceFlags,accepted_user_substitution:reference.summary.accepted_user_substitution}:{}),status:report.calibration.status,selected:report.calibration.selected,report:`.tools/annotation-task9/${reference?'agent-':''}calibration-${name}.json`}));
 }else throw new Error('COMMAND_REQUIRED: coverage | annotate | import | recover | reproduce | judge | local-reproduce | local-judge | calibrate | agent-import | agent-coverage | agent-reproduce | agent-judge | agent-local-reproduce | agent-local-judge | agent-calibrate');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error&&/^[A-Z_ :|]+$/.test(error.message)?error.message:'LABEL_COMMAND_FAILED (private evidence retained)');process.exitCode=1;});
