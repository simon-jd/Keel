import { readFileSync, existsSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { verifyFaithfulnessCalibration, isVerifiedCalibration } from '../src/calibration.js';
import { createFaithfulnessJudge, evaluate, importFrozenQa } from '../src/eval.js';
import { canonical, prompts } from '../../evals/src/judge.js';
import { OFFICIAL_CORPUS_VERSION } from '../src/ingest.js';
import { embeddingProfile } from 'models/rag';
import { RERANK_PROMPT_HASH } from '../src/rerank.js';
import manifest from '../src/calibrationArtifacts.json' with { type: 'json' };
import type { ActualCalibrationBundle } from '../src/calibration.js';
import { hash } from '../../evals/src/judge.js';
const root = new URL('../../../', import.meta.url);
const roles = ['task9V1','task9V2','task9Selection','task9Cohort','task9PrimarySamples','task9SecondarySamples','task9SourceAudit','task9PrimaryReference','task9SecondaryReference','task9ReferenceAudit','domainObservation','domainSamples','domainReference','domainAudit','domainFreeze'] as const;
const unavailable: readonly string[] = manifest.unavailable.roles;
// These read gitignored .tools/ run artifacts, so they are opt-in: KEEL_TEST_ARTIFACTS=1.
// The full-bundle checks also need the inputs listed in manifest.unavailable, which no longer exist.
const present = process.env.KEEL_TEST_ARTIFACTS === '1';
const available = present && unavailable.length === 0;
test('calibration artifact manifest is a plain file list with tracked QA paths', () => {
 expect(Object.keys(manifest)).not.toContain('rootDecision');
 expect(Object.keys(manifest)).not.toContain('authority');
 expect(manifest.kind).toBe('calibration-artifact-manifest');
 expect(Object.keys(manifest.files)).not.toContain('actualDataReview');
 expect(unavailable.every(role => (roles as readonly string[]).includes(role))).toBe(true);
 for (const [role, file] of Object.entries(manifest.files)) {
  if (!unavailable.includes(role)) expect(file.path.startsWith('.superpowers/'), role).toBe(false);
 }
 for (const role of ['frozenQa','frozenQaAudit','qaFreeze'] as const) {
  const raw = readFileSync(new URL(manifest.files[role].path, root), 'utf8');
  expect(manifest.files[role].path.startsWith('data/rag/')).toBe(true);
  expect([Buffer.byteLength(raw), hash(raw)]).toEqual([manifest.files[role].bytes, manifest.files[role].sha256]);
 }
});
test.runIf(present)('every retained calibration artifact is present', () => {
 expect(roles.filter(role => !unavailable.includes(role) && !existsSync(new URL(manifest.files[role].path, root)))).toEqual([]);
});
function bundle() { return Object.fromEntries(roles.map(role => [role, readFileSync(new URL(manifest.files[role].path, root), 'utf8')])) as ActualCalibrationBundle; }
const binding = { alias:'local', model:'keel-local', revision:'4da05a8edb55c6046cce958586c33b61da07bb79', runtimeEvidence:'operator-configured; reviewed local runtime' };
const token = 'fixture-authentication-token-32-chars';
function harness(label:'pass'|'fail'='pass') {
 const posts:Record<string,unknown>[]=[];
 const fetcher:typeof fetch = vi.fn(async (_url, init) => {
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
  if(init?.method === 'GET') return Response.json(manifest.modelProfile);
  const request = JSON.parse(init!.body as string); posts.push(request);
  const usage={input:4,output:3};
  return Response.json({run_id:request.run_id,call_id:request.call_id,localJudgeProfile:manifest.modelProfile,
   action:{role:'assistant',content:JSON.stringify({label,rationale:'Fixture decisive evidence.'}),toolCalls:[]},invalidToolCalls:[],usage,
   accounting:{model:binding.model,provider:'openaiCompatible',status:'success',run_id:request.run_id,call_id:request.call_id,costStatus:'known',costUsd:0,usage,attempts:[{attempt:1,outcome:'success',costStatus:'known',costUsd:0,usage}]}});
 });
 return {fetcher,posts};
}
test('unknown and caller-hash bundles cannot mint an actual receipt',()=>{
 expect(verifyFaithfulnessCalibration({})).toBeNull();
 expect(verifyFaithfulnessCalibration('fabricated','fabricated')).toBeNull();
 expect(isVerifiedCalibration({scope:'actual',...manifest.domain.protocol})).toBe(false);
});
test.skipIf(!available)('exact reviewed distinct BFCL systems and ONE domain pass retain negative/weak diagnostic quality',()=>{
 const raw=bundle();const receipt=verifyFaithfulnessCalibration(raw);
 expect(receipt).toMatchObject({scope:'actual',source:'task9',referenceOrigin:'subagent',human_evidence:false,reliableJudgeAdmitted:false,
  quality:{task9:{selected:'v1',versions:{v1:{agreement:{kappa:-0.03174603174603223}},v2:{agreement:{kappa:-0.03174603174603223}}}},domain:{agreement:{kappa:.24,matrix:[[12,38],[0,50]]},diagnosticCounts:{falsePass:38}}}});
 expect(receipt!.promptHash).toBe(manifest.domain.protocol.systemPromptHash);
 expect(receipt!.protocolHash).toBe(manifest.domain.protocolHash);
 expect(receipt!.quality!.domain.limits.join(' ')).toMatch(/same author.*same model family.*short single-chunk/);
 expect(Object.isFrozen(receipt)).toBe(true);
 expect(Object.isFrozen(receipt!.quality!.domain.agreement.matrix[0])).toBe(true);
 expect(()=>{receipt!.quality!.domain.agreement.matrix[0]![0]=99;}).toThrow();
 expect(isVerifiedCalibration({...receipt})).toBe(false);
 // Every role is independently bound to exact reviewed bytes. Caller recomputation cannot approve new data.
 for(const role of roles) expect(verifyFaithfulnessCalibration({...raw,[role]:raw[role]+' '})).toBeNull();
 expect(verifyFaithfulnessCalibration({...raw,task9V1:raw.task9V2,task9V2:raw.task9V1})).toBeNull();
});
test.skipIf(!available).each(['pass','fail'] as const)('actual scorer sends validated label+rationale wire once, maps %s and awaits intent persistence',async(label)=>{
 const receipt=verifyFaithfulnessCalibration(bundle())!;const {fetcher,posts}=harness(label);
 let release!:()=>void;let entered!:()=>void;
 const pause=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});const events:string[]=[];
 const judge=createFaithfulnessJudge({token,fetch:fetcher,async checkpoint(event){events.push(event.state);if(event.state==='dispatch-intent'){entered();await pause;}}},binding,receipt)!;
 const contexts=[{id:'c',text:'Exact context.'}];
 const pending=judge.score('Question?',contexts,'Answer.',new AbortController().signal);
 await started;expect(posts).toHaveLength(0);contexts[0]!.text='mutated';release();
 const result=await pending;
 expect(result).toMatchObject({score:label==='pass'?1:0,verdict:{label,rationale:'Fixture decisive evidence.'},accounting:{costStatus:'known',costUsd:0}});
 expect(posts).toHaveLength(1);expect(events).toEqual(['dispatch-intent','completed']);
 expect(posts[0]).toMatchObject({model:'local',maxTokens:1024,temperature:0,seed:0,tools:[],messages:[
  {role:'system',content:`${prompts.v1}\nRubric ${manifest.domain.rubric.version}: ${manifest.domain.rubric.text}`},
  {role:'user',content:canonical({input:{question:'Question?',contexts:[{id:'c',text:'Exact context.'}]},action:{answer:'Answer.'}})}]});
 expect(createFaithfulnessJudge({token,fetch:fetcher} as never,binding,receipt)).toBeNull();
 expect(createFaithfulnessJudge({token,fetch:fetcher,checkpoint:async()=>{}},{...binding,revision:'other'},receipt)).toBeNull();
 expect(createFaithfulnessJudge({token,fetch:fetcher,checkpoint:async()=>{}},binding,{...receipt})).toBeNull();
});
test.skipIf(!available)('actual scorer cancellation is per call and persistence failure cannot dispatch',async()=>{
 const receipt=verifyFaithfulnessCalibration(bundle())!;const {fetcher,posts}=harness();
 const controller=new AbortController();controller.abort();
 const judge=createFaithfulnessJudge({token,fetch:fetcher,checkpoint:async()=>{}},binding,receipt)!;
 await expect(judge.score('Q',[{id:'c',text:'C'}],'A',controller.signal)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
 const broken=createFaithfulnessJudge({token,fetch:fetcher,checkpoint:async()=>{throw new Error('private persistence detail');}},binding,receipt)!;
 await expect(broken.score('Q',[{id:'c',text:'C'}],'A',new AbortController().signal)).rejects.toMatchObject({message:'FAITHFULNESS_CHECKPOINT_FAILED'});expect(posts).toHaveLength(0);
 // One cancelled request cannot poison an independent in-flight call.
 let cancel!:()=>void;const aborted=new Promise<void>(r=>{cancel=r;});
 const during:typeof fetch=async(url,init)=>{
  if(init?.method==='GET')return fetcher(url,init);
  cancel();return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
 };
 const active=new AbortController();const pending=createFaithfulnessJudge({token,fetch:during,checkpoint:async()=>{}},binding,receipt)!.score('Q',[{id:'c',text:'C'}],'A',active.signal);
 await aborted;expect((await judge.score('Q',[{id:'c',text:'C'}],'A',new AbortController().signal)).score).toBe(1);active.abort();await expect(pending).rejects.toMatchObject({accounting:{status:'aborted',costStatus:'unknown',attempts:[{outcome:'aborted',costStatus:'unknown'}]}});
 expect((await judge.score('Q',[{id:'c',text:'C'}],'A',new AbortController().signal)).score).toBe(1);
});
test('exact frozen200 QA import binds both authors, audit and freeze and rejects changed bytes',()=>{
 const raw=readFileSync(new URL('data/rag/qa.jsonl',root),'utf8');
 const audit=readFileSync(new URL('data/rag/qa.audit.jsonl',root),'utf8');
 const freeze=readFileSync(new URL('data/rag/qa.freeze.json',root),'utf8');
 const chunks=readFileSync(new URL('data/rag/chunks.jsonl',root),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const ids=new Set<string>(chunks.map(c=>c.id));
 const imported=importFrozenQa(raw,audit,freeze,ids);
 expect(imported).toMatchObject({count:200,complete:true,origins:['agent'],human_evidence:false,human_gold:false,rawHash:manifest.files.frozenQa.sha256});
 expect(imported.provenance).toHaveLength(2);expect(imported.limits.join(' ')).toMatch(/same model family/);
 expect(()=>importFrozenQa(raw+' ',audit,freeze,ids)).toThrow();
 expect(()=>importFrozenQa(raw,audit+' ',freeze,ids)).toThrow();
 expect(()=>importFrozenQa(raw,audit,freeze+' ',ids)).toThrow();
});
test.skipIf(!available)('evaluation output calls the actual measure weak diagnostic judge pass-rate and retains quality',async()=>{
 const receipt=verifyFaithfulnessCalibration(bundle())!;const {fetcher}=harness();
 const judge=createFaithfulnessJudge({token,fetch:fetcher,checkpoint:async()=>{}},binding,receipt)!;
 const report=await evaluate([{id:'fixture',question:'Q',answer:'A',goldChunkIds:['c'],corpusVersion:OFFICIAL_CORPUS_VERSION,origin:'agent',annotator:'fixture',auditRef:'fixture'}],
  {scope:'fixture',corpusVersion:OFFICIAL_CORPUS_VERSION,gitSha:'a'.repeat(40),embeddingProfile:embeddingProfile({alias:'fixture',provider:'openaiCompatible',model:'fixture',revision:'fixture',dimension:3,runtimeEvidence:'fixture'}),reranker:{...binding,promptHash:RERANK_PROMPT_HASH},settings:{k:10,candidateK:10,rrfK:60}},
  async()=>({before:[{id:'c',text:'C'}],after:[{id:'c',text:'C'}],answer:'A',calls:[],elapsedMs:1}),judge);
 expect(report).toMatchObject({faithfulness:null,weakDiagnosticJudgePassRate:1,reliableJudgeAdmitted:false,calibration:{quality:{domain:{diagnosticCounts:{falsePass:38}}}},scoringProtocols:{faithfulness:{maxTokens:1024,protocolHash:manifest.domain.protocolHash}}});
});

test.skipIf(!available).each(['model','profile','protocol','source','coverage','accounting','sample'] as const)('changed %s cannot be approved by recomputed caller hashes',kind=>{
 const raw=bundle();const domain=JSON.parse(raw.domainObservation);
 if(kind==='model')domain.observed[0].accounting.model='other';
 if(kind==='profile')domain.protocol.localJudgeProfile.profile='task9-local-json-schema-v1';
 if(kind==='protocol')domain.protocol.systemPromptHash=manifest.task9.versions.v1.fullSystemPromptHash;
 if(kind==='source')domain.implementationSha256='f'.repeat(64);
 if(kind==='coverage')domain.predictions.pop();
 if(kind==='accounting')domain.observed[0].accounting.attempts.push(domain.observed[0].accounting.attempts[0]);
 if(kind==='sample')domain.observed[0].sampleHash='f'.repeat(64);
 expect(verifyFaithfulnessCalibration({...raw,domainObservation:JSON.stringify(domain)})).toBeNull();
});
test.skipIf(!available)('strict parse/profile failure and completion checkpoint failure preserve incurred accounting',async()=>{
 const receipt=verifyFaithfulnessCalibration(bundle())!;
 for(const kind of ['duplicate-key','profile-mismatch','usage-mismatch','completion-checkpoint'] as const) {
  const {fetcher,posts}=harness();const events:string[]=[];
  const fetchModified:typeof fetch=async(url,init)=>{
   const response=await fetcher(url,init);if(init?.method!=='POST')return response;
   const body=await response.json();
   if(kind==='duplicate-key')body.action.content='{"label":"pass","label":"fail","rationale":"Duplicate label."}';
   if(kind==='profile-mismatch')body.localJudgeProfile={...body.localJudgeProfile,liveEnforcement:'PROVEN'};
   if(kind==='usage-mismatch')body.usage={input:99,output:3};
   return Response.json(body);
  };
  const judge=createFaithfulnessJudge({token,fetch:fetchModified,async checkpoint(event){events.push(event.state);if(kind==='completion-checkpoint'&&event.state==='completed')throw new Error('private disk failure');}},binding,receipt)!;
  const error=await judge.score('Q',[{id:'c',text:'C'}],'A',new AbortController().signal).catch(e=>e);
  expect(error).toMatchObject({accounting:{status:'success',costStatus:'known',costUsd:0,attempts:[{outcome:'success',costStatus:'known'}]}});
  expect(posts).toHaveLength(1);expect(events).toEqual(['dispatch-intent',kind==='completion-checkpoint'?'completed':'failed']);
  expect(error.message).not.toContain('private');
 }
});
test.skipIf(!available)('abort during durable intent prevents POST, and altered options/binding cannot change an admitted call',async()=>{
 const receipt=verifyFaithfulnessCalibration(bundle())!;const {fetcher,posts}=harness();const controller=new AbortController();
 const events:string[]=[];
 const judge=createFaithfulnessJudge({token,fetch:fetcher,async checkpoint(event){events.push(event.state);if(event.state==='dispatch-intent')controller.abort();}},binding,receipt)!;
 await expect(judge.score('Q',[{id:'c',text:'C'}],'A',controller.signal)).rejects.toMatchObject({message:'FAITHFULNESS_ABORTED'});
 expect(posts).toHaveLength(0);expect(events).toEqual(['dispatch-intent','failed']);
 const config={token,fetch:fetcher,checkpoint:async()=>{}};const mutableBinding={...binding};
 const fixed=createFaithfulnessJudge(config,mutableBinding,receipt)!;config.token='changed';mutableBinding.alias='changed';
 expect((await fixed.score('Q',[{id:'c',text:'C'}],'A',new AbortController().signal)).score).toBe(1);
 expect(createFaithfulnessJudge({token,fetch:fetcher,checkpoint:async()=>{},endpoint:'http://127.0.0.1:9999/v1/agent/step'},binding,receipt)).toBeNull();
 expect(createFaithfulnessJudge({token,fetch:fetcher,checkpoint:async()=>{}},binding,JSON.parse(JSON.stringify(receipt)))).toBeNull();
});
test('actual evaluation requires the exact frozen population before any prediction',async()=>{
 const predict=vi.fn(async()=>{throw new Error('must not dispatch');});
 await expect(evaluate([],{scope:'actual',corpusVersion:OFFICIAL_CORPUS_VERSION,gitSha:'a'.repeat(40),embeddingProfile:embeddingProfile({alias:'fixture',provider:'openaiCompatible',model:'fixture',revision:'fixture',dimension:3,runtimeEvidence:'fixture'}),reranker:{...binding,promptHash:RERANK_PROMPT_HASH},settings:{k:10,candidateK:10,rrfK:60}},predict)).rejects.toThrow('INVALID_EVAL_BINDING');
 expect(predict).not.toHaveBeenCalled();
});
test.skipIf(!available)('caller abort during completion persistence retains the durably completed observation and cost',async()=>{
 const receipt=verifyFaithfulnessCalibration(bundle())!;const {fetcher,posts}=harness();const controller=new AbortController();const events:string[]=[];
 const judge=createFaithfulnessJudge({token,fetch:fetcher,async checkpoint(event){events.push(event.state);if(event.state==='completed')controller.abort();}},binding,receipt)!;
 await expect(judge.score('Q',[{id:'c',text:'C'}],'A',controller.signal)).rejects.toMatchObject({message:'FAITHFULNESS_ABORTED',checkpointStatus:'delivered',accounting:{status:'success',costStatus:'known'}});
 expect(events).toEqual(['dispatch-intent','completed']);expect(posts).toHaveLength(1);
});
