import {expect,test} from 'vitest';
import {mkdtempSync,chmodSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadCohort,registerFixtureWorkspaceForTests,readSecret,importLabels,readLabels,writePrivate} from '../src/routes/label.js';
import {canonical,hash,prompts,RUBRIC} from '../../../packages/evals/src/judge.js';
function fixture(admit=true){
 const root=mkdtempSync(join(tmpdir(),'keel-annotation-fixture-'));chmodSync(root,0o700);
 const primary=[{id:'a',input:{messages:[{role:'user',content:'ask'}],tools:[]},action:{role:'assistant',content:'answer',toolCalls:[]}},{id:'b',input:{messages:[],tools:[]},action:{}}];
 const p=primary.map(canonical).join('\n')+'\n',s=canonical(primary[0])+'\n',audit='[]\n';
 const metadata={schema:1,primaryIds:['a','b'],secondaryIds:['a'],primaryHash:hash(p),secondaryHash:hash(s),auditHash:hash(audit),rubricVersion:RUBRIC.version,rubricHash:hash(canonical(RUBRIC)),promptVersions:['v1','v2'],promptHashes:{v1:hash(prompts.v1),v2:hash(prompts.v2)}};
 writePrivate(join(root,'primary.blind.jsonl'),p);writePrivate(join(root,'secondary.blind.jsonl'),s);writePrivate(join(root,'source.audit.json'),audit);writePrivate(join(root,'cohort.json'),canonical({...metadata,cohortHash:hash(canonical(metadata))}));
 writePrivate(join(root,'primary.labels.jsonl'),'');writePrivate(join(root,'secondary.labels.jsonl'),'');if(admit)registerFixtureWorkspaceForTests(root);return root;
}
test('blind files and fixed cohort binding reject tamper or source leakage',()=>{
 const root=fixture();try{expect(loadCohort(root).primary).toHaveLength(2);writeFileSync(join(root,'primary.blind.jsonl'),'{}');expect(()=>loadCohort(root)).toThrow();}finally{rmSync(root,{recursive:true});}
});
test('owned private token only; no symlinks, permissive modes or oversized secret',()=>{
 const root=fixture();try{const p=join(root,'token');writePrivate(p,'x'.repeat(32));expect(readSecret(p)).toBe('x'.repeat(32));symlinkSync(p,join(root,'link'));expect(()=>readSecret(join(root,'link'))).toThrow();chmodSync(p,0o644);expect(()=>readSecret(p)).toThrow();chmodSync(p,0o600);writeFileSync(p,'x'.repeat(5000));expect(()=>readSecret(p)).toThrow();}finally{rmSync(root,{recursive:true});}
});
test('human import is audited, resumable without relabeling, rejects inferred labels and same secondary rater',()=>{
 const root=fixture();try{const cohort=loadCohort(root);const label={id:'a',label:'pass',rater:'human-one',origin:'human',rubricVersion:RUBRIC.version,cohortHash:cohort.metadata.cohortHash,annotatedAt:'2026-10-24T12:00:00Z'};
 const result=importLabels(root,'primary',[label]);expect(result.labeled).toBe(1);expect(readLabels(root,'primary')).toEqual([label]);expect(readFileSync(join(root,'imports',result.transaction,'record.json'),'utf8')).toContain('afterHash');
 expect(()=>importLabels(root,'primary',[{...label,label:'fail'}])).toThrow();expect(()=>importLabels(root,'secondary',[label])).toThrow();expect(()=>importLabels(root,'primary',[{...label,id:'b',origin:'judge'}])).toThrow();
 expect(importLabels(root,'secondary',[{...label,rater:'human-two'}]).complete).toBe(true);
 }finally{rmSync(root,{recursive:true});}
});
test('import crash stops coverage and recovery accepts only the recorded after-image',async()=>{
 const {recoverImport}=await import('../src/routes/label.js');const root=fixture();
 try{const cohort=loadCohort(root),label={id:'a',label:'fail',rater:'human-one',origin:'human',rubricVersion:RUBRIC.version,cohortHash:cohort.metadata.cohortHash,annotatedAt:'2026-10-24T12:00:00Z'};
 const result=importLabels(root,'primary',[label]);rmSync(join(root,'imports',result.transaction,'complete.json'));
 expect(()=>readLabels(root,'primary')).toThrow('IMPORT_PENDING');expect(recoverImport(root)).toHaveProperty('recovered');expect(readLabels(root,'primary')).toEqual([label]);
 }finally{rmSync(root,{recursive:true});}
});
test('fixture judge goes through authenticated Keel HTTP app and packages/models router',async()=>{
 const {createAgentApp}=await import('../src/routes/agent.js');const {createRouter}=await import('models/router');const {createJudge}=await import('../../../packages/evals/src/judge.js');
 const {vi}=await import('vitest');const token='fixture-token-'.repeat(4);let providers=0;
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  providers++;expect(String(url)).toBe('http://127.0.0.1:19000/v1/chat/completions');const body=JSON.parse(String(init.body));expect(body).toMatchObject({seed:0,temperature:0,max_tokens:1024,model:'fixture-local',tools:[]});
  const text=JSON.stringify({label:'pass',rationale:'fixture only'});
  const event={choices:[{index:0,delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:7}};
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
 });
 try{const model=createRouter({local:{provider:'openaiCompatible',endpoint:'http://127.0.0.1:19000/v1',model:'fixture-local',pricing:{inputPerMillion:0,outputPerMillion:0}}});
 const app=createAgentApp({model,token,maxRequests:1});const judge=createJudge({token,fetch:async(url,init)=>app.fetch(new Request(String(url),init))});
 const result=await judge.observe({id:'fixture',input:{messages:[],tools:[]},action:{role:'assistant',content:'fixture',toolCalls:[]}},RUBRIC);
 expect(result.verdict.label).toBe('pass');expect(result.accounting).toMatchObject({model:'fixture-local',provider:'openaiCompatible',costStatus:'known',costUsd:0});expect(providers).toBe(1);
 await expect(judge.score({id:'fixture',input:{},action:{}},RUBRIC)).rejects.toThrow('JUDGE_HTTP_STATUS_429');expect(providers).toBe(1);
 }finally{vi.unstubAllGlobals();}
});
test('stored judge comparison binds complete observations, exact model and implementation provenance',async()=>{
 const {admitJudgeRun}=await import('../src/routes/label.js');const root=fixture();
 try{const cohort=loadCohort(root),observed=cohort.primary.map(sample=>{
 const action={role:'assistant',content:JSON.stringify({label:'pass',rationale:'fixture only'}),toolCalls:[]},verdict={label:'pass',rationale:'fixture only'};
 return {sampleId:sample.id,sampleHash:hash(canonical(sample)),promptVersion:'v1',promptHash:hash(`${prompts.v1}\nRubric ${RUBRIC.version}: ${RUBRIC.text}`),rubricHash:hash(canonical(RUBRIC)),action,verdict,semanticHash:hash(canonical({action,verdict})),rawResponseHash:'a'.repeat(64),accounting:{model:'fixture-local'},temperature:0,seed:0,maxTokens:1024};
 });const run={schema:1,status:'completed',cohortHash:cohort.metadata.cohortHash,rubricHash:hash(canonical(RUBRIC)),promptVersion:'v1',promptHash:hash(prompts.v1),seed:0,temperature:0,maxTokens:1024,requestedModel:'local',implementationSha256:'b'.repeat(64),gitSha:'c'.repeat(40),requestsAttempted:2,completed:2,result:{predictions:cohort.primary.map(s=>({id:s.id,label:'pass'})),observed}};
 expect(admitJudgeRun(run,cohort).model).toBe('fixture-local');
 for(const bad of [{...run,implementationSha256:undefined},{...run,completed:1},{...run,promptHash:'wrong'},{...run,result:{...run.result,observed:observed.map(r=>({...r,sampleHash:'wrong'}))}},{...run,result:{...run.result,observed:observed.map(r=>({...r,verdict:{label:'fail',rationale:'tampered'}}))}}])expect(()=>admitJudgeRun(bad,cohort)).toThrow();
 }finally{rmSync(root,{recursive:true});}
});
test('production rejects self-consistent arbitrary cohorts before import writes or reads secrets',()=>{
 const root=fixture(false);try{
 const path=join(root,'cohort.json'),metadata=JSON.parse(readFileSync(path,'utf8'));const {cohortHash:_,...binding}=metadata;binding.protocol='arbitrary';binding.population=2;
 writeFileSync(path,canonical({...binding,cohortHash:hash(canonical(binding))}));
 expect(()=>loadCohort(root)).toThrow('FROZEN_COHORT_REQUIRED');
 expect(()=>importLabels(root,'primary',[])).toThrow('FROZEN_COHORT_REQUIRED');
 expect(readFileSync(join(root,'primary.labels.jsonl'),'utf8')).toBe('');
 }finally{rmSync(root,{recursive:true});}
});
test('agent reference import preserves source bytes and human files, audits attribution and rejects tamper',async()=>{
 const {mkdirSync}=await import('node:fs');const {importAgentReference,readAgentReference}=await import('../src/routes/label.js');const root=fixture();
 try{const cohort=loadCohort(root),source=join(root,'agent-source');mkdirSync(source,{mode:0o700});
 const inputHashes=new Map(readFileSync(join(root,'primary.blind.jsonl'),'utf8').trimEnd().split('\n').map(line=>[JSON.parse(line).id,hash(line)]));
 const labels=cohort.primary.map((s,i)=>({id:s.id,label:i?'fail':'pass',origin:'subagent',rater:'fixture-agent-one',rubricVersion:RUBRIC.version,cohortHash:cohort.metadata.cohortHash,rationale:'Disposable fixture',confidence:'medium',annotatedAt:'2026-10-25T08:01:02.123456Z',inputSha256:inputHashes.get(s.id)}));
 const p=labels.map(canonical).join('\n')+'\n',s=canonical({...labels[0],rater:'fixture-agent-two'})+'\n';writePrivate(join(source,'primary.agent-labels.jsonl'),p);writePrivate(join(source,'secondary.agent-labels.jsonl'),s);
 expect(()=>readAgentReference(root,source)).toThrow('AGENT_REFERENCE_IMPORT_REQUIRED');
 const report=importAgentReference(root,source);expect(report).toMatchObject({reference_origin:'subagent',human_evidence:false,human_reference_gate_fulfilled:false,accepted_user_substitution:true});
 expect(readAgentReference(root,source).primary).toHaveLength(2);expect(readFileSync(join(source,'primary.agent-labels.jsonl'),'utf8')).toBe(p);expect(readLabels(root,'primary')).toEqual([]);
 expect(()=>importLabels(root,'primary',labels)).toThrow();expect(()=>importAgentReference(root,source)).toThrow();
 writeFileSync(join(source,'primary.agent-labels.jsonl'),p.replace('medium','high'));expect(()=>readAgentReference(root,source)).toThrow('AGENT_REFERENCE_AUDIT_MISMATCH');
 }finally{rmSync(root,{recursive:true});}
});
test('explicit weak-reference judge admission accepts imported agents while human default stays blocked',async()=>{
 const {mkdirSync}=await import('node:fs');const {admitModelReference,admitJudgeReference,importAgentReference,readAgentReference}=await import('../src/routes/label.js');const root=fixture();
 try{const cohort=loadCohort(root),source=join(root,'agent-source');mkdirSync(source,{mode:0o700});const lines=readFileSync(join(root,'primary.blind.jsonl'),'utf8').trimEnd().split('\n');
 const labels=lines.map(line=>({id:JSON.parse(line).id,label:'pass',origin:'subagent',rater:'fixture-agent-one',rubricVersion:RUBRIC.version,cohortHash:cohort.metadata.cohortHash,rationale:'Disposable fixture',confidence:'high',annotatedAt:'2026-10-25T08:01:02.000000Z',inputSha256:hash(line)}));
 writePrivate(join(source,'primary.agent-labels.jsonl'),labels.map(canonical).join('\n')+'\n');writePrivate(join(source,'secondary.agent-labels.jsonl'),canonical({...labels[0],rater:'fixture-agent-two'})+'\n');importAgentReference(root,source);
 expect(()=>admitModelReference('judge','human',root,source)).toThrow('HUMAN_PRIMARY_COVERAGE_REQUIRED');
 expect(admitModelReference('judge','subagent',root,source)?.summary.human_evidence).toBe(false);
 const reference=readAgentReference(root,source),run={reference_origin:'subagent',human_evidence:false,human_reference_gate_fulfilled:false,accepted_user_substitution:true,referenceAuditHash:reference.auditHash,referenceSourceHashes:reference.summary.sourceHashes};
 expect(()=>admitJudgeReference(run,reference)).not.toThrow();expect(()=>admitJudgeReference(run,null)).toThrow();
 for(const bad of [{...run,human_evidence:true},{...run,reference_origin:'human'},{...run,referenceSourceHashes:{}},{...run,referenceAuditHash:'wrong'}])expect(()=>admitJudgeReference(bad,reference)).toThrow();
 }finally{rmSync(root,{recursive:true});}
});
test('local profile run admission requires complete attribution and call identity; comparison rejects legacy/profile/revision mixing',async()=>{
 const {admitJudgeRun,admitJudgeComparison}=await import('../src/routes/label.js');const {localJudgeIdentityFromEnvironment,LOCAL_JUDGE_PROFILE}=await import('models/localJudgeProfile');const root=fixture();
 try{
 const cohort=loadCohort(root),profile=localJudgeIdentityFromEnvironment({KEEL_LOCAL_JUDGE_PROFILE:LOCAL_JUDGE_PROFILE,KEEL_LOCAL_JUDGE_MODEL_SOURCE:'fixture/model',KEEL_LOCAL_JUDGE_MODEL_REVISION:'a'.repeat(40),KEEL_LOCAL_JUDGE_RUNTIME_VERSION:'0.17.1'})!;
 const observed=cohort.primary.map(sample=>{
  const action={role:'assistant',content:JSON.stringify({label:'pass',rationale:'A'}),toolCalls:[]},verdict={label:'pass',rationale:'A'},run='12345678-abcd-4000-a000-123456789012',call=`${run}:1`,usage={input:2,output:3};
  return {sampleId:sample.id,sampleHash:hash(canonical(sample)),promptVersion:'v1',promptHash:hash(`${prompts.v1}\nRubric ${RUBRIC.version}: ${RUBRIC.text}`),rubricHash:hash(canonical(RUBRIC)),action,verdict,semanticHash:hash(canonical({action,verdict})),rawResponseHash:'a'.repeat(64),temperature:0,seed:0,maxTokens:1024,localJudgeProfile:profile,runId:run,callId:call,requestedRunId:run,requestedCallId:call,usage,accounting:{model:'keel-local',provider:'openaiCompatible',status:'success',run_id:run,call_id:call,costStatus:'known',costUsd:0,usage,attempts:[{attempt:1,outcome:'success',costStatus:'known',costUsd:0,usage}]}};
 });
 const run={schema:2,localJudgeProfile:profile,status:'completed',cohortHash:cohort.metadata.cohortHash,rubricHash:hash(canonical(RUBRIC)),promptVersion:'v1',promptHash:hash(prompts.v1),seed:0,temperature:0,maxTokens:1024,requestedModel:'local',implementationSha256:'b'.repeat(64),gitSha:'c'.repeat(40),requestsAttempted:2,completed:2,result:{predictions:cohort.primary.map(s=>({id:s.id,label:'pass'})),observed}};
 const admitted=admitJudgeRun(run,cohort);expect(admitted.localJudgeProfile).toEqual(profile);expect(admitJudgeComparison(admitted,admitted)).toEqual(admitted);
 for(const changed of [{usage:{input:900,output:800}},{usage:undefined},{costStatus:'unknown'},{costUsd:undefined}])expect(()=>admitJudgeRun({...run,result:{...run.result,observed:observed.map(r=>({...r,accounting:{...r.accounting,attempts:[{...r.accounting.attempts[0],...changed}]}}))}},cohort)).toThrow('JUDGE_PREDICTION_BINDING');
 for(const bad of [{...run,localJudgeProfile:undefined},{...run,schema:1},{...run,result:{...run.result,observed:observed.map(r=>({...r,localJudgeProfile:undefined}))}},{...run,result:{...run.result,observed:observed.map(r=>({...r,runId:undefined,callId:undefined,requestedRunId:undefined,requestedCallId:undefined,accounting:{...r.accounting,run_id:undefined,call_id:undefined}}))}},{...run,result:{...run.result,observed:observed.map(r=>({...r,accounting:{...r.accounting,attempts:[{attempt:1}]}}))}}])expect(()=>admitJudgeRun(bad,cohort)).toThrow();
 const legacy={...run,schema:1,localJudgeProfile:undefined,result:{...run.result,observed:observed.map(r=>({...r,localJudgeProfile:undefined}))}};const admittedLegacy=admitJudgeRun(legacy,cohort);
 expect(()=>admitJudgeComparison(admittedLegacy,admitted)).toThrow('PROTOCOL_DRIFT');
 const otherProfile={...profile,configured:{...profile.configured,modelRevision:'d'.repeat(40)}};const other={...run,localJudgeProfile:otherProfile,result:{...run.result,observed:observed.map(r=>({...r,localJudgeProfile:otherProfile}))}};
 expect(()=>admitJudgeComparison(admitted,admitJudgeRun(other,cohort))).toThrow('PROTOCOL_DRIFT');
 const v2=localJudgeIdentityFromEnvironment({KEEL_LOCAL_JUDGE_PROFILE:'task9-local-json-schema-v2',KEEL_LOCAL_JUDGE_MODEL_SOURCE:'fixture/model',KEEL_LOCAL_JUDGE_MODEL_REVISION:'a'.repeat(40),KEEL_LOCAL_JUDGE_RUNTIME_VERSION:'0.17.1'})!;
 const newRun={...run,localJudgeProfile:v2,result:{...run.result,observed:observed.map(r=>({...r,localJudgeProfile:v2}))}};
 const admittedV2=admitJudgeRun(newRun,cohort);expect(admittedV2.localJudgeProfile).toEqual(v2);
 expect(()=>admitJudgeComparison(admitted,admittedV2)).toThrow('PROTOCOL_DRIFT');
 expect(()=>admitJudgeRun({...newRun,result:{...newRun.result,observed}},cohort)).toThrow('JUDGE_PREDICTION_BINDING');
 }finally{rmSync(root,{recursive:true});}
});
