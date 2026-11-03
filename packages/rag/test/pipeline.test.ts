import { expect, test } from 'vitest';
import { createReranker } from '../src/rerank.js';
import { createFaithfulnessJudge, importQa, FAITHFULNESS_PROMPT_HASH } from '../src/eval.js';
import { chunkDocument, sha256 } from '../src/ingest.js';
import type { CallAccounting, ModelClient } from 'models/types';
const binding={alias:'fixture',model:'fixture-score',revision:'fixture-rev',runtimeEvidence:'fixture-only'};
const accounting:CallAccounting={model:binding.model,provider:'openaiCompatible',status:'success',costUsd:0,costStatus:'known',usage:{input:1,output:1},attempts:[{attempt:1,outcome:'success',costStatus:'known',costUsd:0,usage:{input:1,output:1}}]};
const chunks=['one','two','three'].map(text=>chunkDocument('fixture','fixture.md',text,'https://fixture.test')[0]!);
test('model rerank calls every candidate, orders scores stably, and retains failed call costs',async()=>{
 let count=0;const client:ModelClient={async *stream(){count++;yield{text:JSON.stringify({score:count===1?.2:.9}),accounting};}};
 const result=await createReranker(client,binding)('query',chunks,2);
 expect(count).toBe(3);expect(result.chunks.map(c=>c.text)).toEqual(['two','three']);expect(result.calls).toHaveLength(3);expect(result.candidateIds).toEqual(chunks.map(c=>c.id));
 const broken:ModelClient={async *stream(){yield{text:'not-json',accounting};}};
 await expect(createReranker(broken,binding)('query',chunks,2)).rejects.toMatchObject({message:'RERANK_FAILED',calls:[accounting,accounting,accounting],failures:[{code:'MODEL_SCORE_FAILED'},{code:'MODEL_SCORE_FAILED'},{code:'MODEL_SCORE_FAILED'}]});
});
test('real QA requires trusted batch attestation and exact bytes, never silently upgrades agent origin',()=>{
 const row={id:'q',question:'Question',answer:'Answer',goldChunkIds:['a'],corpusVersion:'v',origin:'human' as const,annotator:'person',auditRef:'audit:1'};
 const input=JSON.stringify(row);const policy={allowedOrigins:['human' as const],provenance:[{origin:'human' as const,annotator:'person',auditRef:'audit:1',inputHash:sha256(input)}]};
 expect(()=>importQa(input,'v',new Set(['a']),{allowedOrigins:['human']})).toThrow('QA_PROVENANCE_REQUIRED');
 expect(importQa(input,'v',new Set(['a']),policy).count).toBe(1);
 expect(()=>importQa(input+'\n','v',new Set(['a']),policy)).toThrow('QA_PROVENANCE_REQUIRED');
 expect(()=>importQa(input.replace('human','agent'),'v',new Set(['a']),{...policy,allowedOrigins:['agent']})).toThrow();
});
test('BFCL or changed protocol cannot unlock Kubernetes faithfulness',()=>{
 const client:ModelClient={async *stream(){throw new Error('MUST_NOT_CALL');}};
 expect(createFaithfulnessJudge(client,binding,null)).toBeNull();
 const calibration={source:'task9' as const,status:'calibrated' as const,artifactHash:'a'.repeat(64),model:binding.model,revision:binding.revision,promptHash:FAITHFULNESS_PROMPT_HASH,protocolHash:'b'.repeat(64),rubricHash:'c'.repeat(64),domain:'kubernetes-grounding' as const,referenceOrigin:'agent' as const,domainValidationHash:'d'.repeat(64)};
 expect(createFaithfulnessJudge(client,binding,calibration)).toBeNull();
});
test('hash-only fabricated calibration remains closed even with all matching exported hashes',async()=>{
 const {FAITHFULNESS_PROTOCOL_HASH,FAITHFULNESS_RUBRIC_HASH}=await import('../src/eval.js');
 const client:ModelClient={async *stream(){throw new Error('MUST_NOT_CALL');}};
 const forged={source:'task9' as const,status:'calibrated' as const,artifactHash:'a'.repeat(64),model:binding.model,revision:binding.revision,promptHash:FAITHFULNESS_PROMPT_HASH,protocolHash:FAITHFULNESS_PROTOCOL_HASH,rubricHash:FAITHFULNESS_RUBRIC_HASH,domain:'kubernetes-grounding' as const,referenceOrigin:'agent' as const,domainValidationHash:'d'.repeat(64)};
 expect(createFaithfulnessJudge(client,binding,forged)).toBeNull();
});
test('verified synthetic artifacts open only a fixture receipt; incomplete or altered records fail closed',async()=>{
 const {compareLabels}=await import('../../evals/src/calibration.js');
 const {canonical,hash}=await import('../../evals/src/judge.js');
 const {OFFICIAL_CORPUS_VERSION}=await import('../src/ingest.js');
 const {verifyFixtureFaithfulnessCalibration,verifyFaithfulnessCalibration}=await import('../src/calibration.js');
 const {FAITHFULNESS_PROTOCOL_HASH,FAITHFULNESS_RUBRIC_HASH,evaluate}=await import('../src/eval.js');
 const {embeddingProfile}=await import('models/rag');
 const {RERANK_PROMPT_HASH}=await import('../src/rerank.js');
 const identity={model:binding.model,revision:binding.revision,promptHash:FAITHFULNESS_PROMPT_HASH,protocolHash:FAITHFULNESS_PROTOCOL_HASH,rubricHash:FAITHFULNESS_RUBRIC_HASH};
 const samples=['a','b'].map(id=>({id,input:{question:'fixture '+id,contexts:[{id:'fixture-context',text:'explicit synthetic context'}]},action:{answer:'fixture answer'}}));
 const ids=samples.map(s=>s.id);const labels=ids.map((id,i)=>({id,label:i?'fail':'pass'}));const predictions={v1:labels,v2:labels};
 const cohortHash=hash(canonical(samples));
 const reference=labels.map(row=>({...row,origin:'subagent' as const,rater:'fixture-agent',rubricVersion:'fixture-rubric',cohortHash,annotatedAt:'2026-10-25T00:00:00Z',rationale:'explicit synthetic fixture',confidence:'high' as const,inputSha256:hash(canonical(samples.find(s=>s.id===row.id)))}));
 const records=Object.entries(predictions).flatMap(([version,rows])=>rows.map(row=>({...identity,...row,version,sampleHash:hash(canonical(samples.find(s=>s.id===row.id)))})));
 const artifact={schema:1 as const,scope:'fixture' as const,kind:'task9-calibration' as const,...identity,referenceOrigin:'subagent' as const,human_evidence:false,cohortHash,rubricVersion:'fixture-rubric',samples,reference,predictions,records,comparison:compareLabels(ids,reference,predictions)};
 const task9Raw=JSON.stringify(artifact);const domain={...artifact,kind:'kubernetes-grounding-validation',corpusVersion:OFFICIAL_CORPUS_VERSION,task9ArtifactHash:sha256(task9Raw)};const domainRaw=JSON.stringify(domain);
 const approval={purpose:'synthetic-unit-test' as const,...identity,referenceOrigin:'subagent' as const,task9ArtifactHash:sha256(task9Raw),domainArtifactHash:sha256(domainRaw),task9Ids:ids,domainIds:ids};
 const receipt=verifyFixtureFaithfulnessCalibration(task9Raw,domainRaw,approval);expect(receipt).toMatchObject({scope:'fixture',human_evidence:false});
 expect(verifyFaithfulnessCalibration(task9Raw,domainRaw)).toBeNull();
 expect(verifyFixtureFaithfulnessCalibration(task9Raw,domainRaw+' ',approval)).toBeNull();
 for(const changed of [{...domain,records:records.slice(1)},{...domain,referenceOrigin:'human'},{...domain,revision:'forged'},{...domain,predictions:{v1:labels.slice(1),v2:labels}},{...domain,records:records.map((r,i)=>i?r:{...r,sampleHash:'f'.repeat(64)})}]){
  const raw=JSON.stringify(changed);expect(verifyFixtureFaithfulnessCalibration(task9Raw,raw,{...approval,domainArtifactHash:sha256(raw)})).toBeNull();
 }
 let calls=0;const client:ModelClient={async *stream(){calls++;yield{text:'{"score":1}',accounting};}};
 const mutableBinding={...binding};const judge=createFaithfulnessJudge(client,mutableBinding,receipt)!;mutableBinding.alias='forged';
 expect(judge.binding.alias).toBe('fixture');expect(Object.isFrozen(judge.calibration)).toBe(true);expect(createFaithfulnessJudge(client,binding,{...receipt,scope:'actual'})).toBeNull();
 const contexts=[{id:'fixture-context',text:'original context'}];const pending=judge.score('fixture question',contexts,'fixture answer',new AbortController().signal);contexts[0]!.text='changed';
 expect((await pending).inputHash).toBe(sha256(JSON.stringify({question:'fixture question',contexts:[{id:'fixture-context',text:'original context'}],answer:'fixture answer'})));expect(calls).toBe(1);
 await expect(evaluate([],{scope:'actual',corpusVersion:OFFICIAL_CORPUS_VERSION,gitSha:'a'.repeat(40),embeddingProfile:embeddingProfile({alias:'fixture',provider:'openaiCompatible',model:'fixture',revision:'fixture',dimension:3,runtimeEvidence:'fixture-only'}),reranker:{...binding,promptHash:RERANK_PROMPT_HASH},settings:{k:10,candidateK:10,rrfK:60}},async()=>{throw new Error('MUST_NOT_PREDICT');},judge)).rejects.toThrow('INVALID_EVAL_BINDING');
});
test('rerank binds candidate text and model alias before asynchronous scoring',async()=>{
 const mutableBinding={...binding};const candidates=structuredClone(chunks);let release!:()=>void;let entered!:()=>void;
 const paused=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});const aliases:string[]=[];const documents:string[]=[];
 const client:ModelClient={async *stream(req){aliases.push(req.model);documents.push(JSON.parse(req.messages[1]!.content).document);if(aliases.length===1){entered();await paused;}yield{text:'{"score":1}',accounting};}};
 const pending=createReranker(client,mutableBinding)('query',candidates,2);await started;mutableBinding.alias='forged';candidates[1]!.text='forged';release();
 const result=await pending;expect(aliases).toEqual(['fixture','fixture','fixture']);expect(documents).toEqual(['one','two','three']);expect(result.binding.alias).toBe('fixture');
});
