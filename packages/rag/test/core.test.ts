import { expect, test } from 'vitest';
import { rrf } from '../src/retrieve.js';
import { normalize, chunkDocument, sha256 } from '../src/ingest.js';
import { embeddingProfile } from 'models/rag';
import { RERANK_PROMPT_HASH } from '../src/rerank.js';
import { importQa, recallAtK, evaluate } from '../src/eval.js';

test('rrfMergesRanks', () => {
 const merged=rrf([[{id:'b'},{id:'a'},{id:'a'}],[{id:'a'},{id:'c'}]]);
 expect(merged.map(x=>x.id)).toEqual(['a','b','c']);
 expect(merged[0]?.score).toBeCloseTo(1/62+1/61);
 expect(rrf([[{id:'b'}],[{id:'a'}]]).map(x=>x.id)).toEqual(['a','b']);
});
test('normalization preserves text/line provenance and records unresolved includes',()=>{
 const input='---\ntitle: Pods\n---\n# Pods\n{{< note >}}\nPods run. {{< glossary_tooltip text="container" term_id="container" >}}\n{{< /note >}}\n{{% code_sample file="pods.yaml" %}}\n<!-- hidden -->\nLast line.';
 const result=normalize(input);
 expect(result.lines).toContainEqual({line:6,text:'Pods run. container'});
 expect(result.omissions).toContainEqual({line:8,kind:'code_sample'});
 expect(result.lines.some(x=>x.text.includes('hidden'))).toBe(false);
 const chunks=chunkDocument('corpus', 'pods.md', input, 'https://example.test/pods', 20);
 expect(chunks.length).toBeGreaterThan(1);expect(chunks).toEqual(chunkDocument('corpus','pods.md',input,'https://example.test/pods',20));
 expect(new Set(chunks.map(c=>c.id)).size).toBe(chunks.length);
 for(const c of chunks)expect(c.contentHash).toBe(sha256(c.text));
});
test('QA import rejects another corpus, unknown golds, duplicates and forged origins',()=>{
 const row={id:'q',question:'What runs?',answer:'Pods',goldChunkIds:['a'],corpusVersion:'v',origin:'fixture',annotator:'fixture-author',auditRef:'fixture-audit'};
 expect(importQa(JSON.stringify(row),'v',new Set(['a']),{allowedOrigins:['fixture'],expectedCount:200}).complete).toBe(false);
 for(const bad of [{...row,corpusVersion:'x'},{...row,goldChunkIds:['missing']},{...row,origin:'human'}])expect(()=>importQa(JSON.stringify(bad),'v',new Set(['a']),{allowedOrigins:['fixture']})).toThrow();
 expect(()=>importQa([row,row].map(x=>JSON.stringify(x)).join('\n'),'v',new Set(['a']),{allowedOrigins:['fixture']})).toThrow();
 expect(recallAtK(['a','b'],['a','a'],10)).toBe(.5);
 expect(recallAtK(['a'],[],10)).toBe(0);
 expect(()=>recallAtK([],[],10)).toThrow();
});
test('paired evaluation retains failed denominators and gates uncalibrated faithfulness',async()=>{
 const rows=['q1','q2'].map(id=>({id,question:id,answer:'reference',goldChunkIds:['a'],corpusVersion:'v',origin:'fixture' as const,annotator:'fixture',auditRef:'fixture'}));
 const report=await evaluate(rows,{scope:'fixture',corpusVersion:'v',gitSha:'a'.repeat(40),embeddingProfile:embeddingProfile({alias:'fixture',provider:'openaiCompatible',model:'fixture',revision:'fixture',dimension:3,runtimeEvidence:'fixture-only'}),reranker:{alias:'fixture',model:'fixture',revision:'fixture',runtimeEvidence:'fixture-only',promptHash:RERANK_PROMPT_HASH},settings:{k:10,candidateK:20,rrfK:60}},async q=>{if(q==='q2')throw new Error('private text');return {before:[{id:'a',text:'context'}],after:[{id:'a',text:'context'}],calls:[],elapsedMs:1};});
 expect(report.total).toBe(2);expect(report.completed).toBe(1);expect(report.beforeRecallAt10).toBe(.5);expect(report.afterRecallAt10).toBe(.5);expect(report.complete).toBe(false);expect(report.faithfulness).toBeNull();expect(report).toMatchObject({scoringProtocols:{rerank:{temperature:0,seed:0,maxTokens:128,protocolVersion:'rag-score-json-v1'},faithfulness:{temperature:0,seed:0,maxTokens:128,status:'gated',protocolVersion:'rag-faithfulness-v1'}}});expect(JSON.stringify(report)).not.toContain('private text');
});
test('committed corpus is reproducible with exact frozen weak-reference QA and only pinned sources',async()=>{
 const {prepareCorpus}=await import('../src/prepare.js');
 const {readFile}=await import('node:fs/promises');
 const result=await prepareCorpus(new URL('../../../data/rag/',import.meta.url).pathname,true);
 expect(result.documents).toBe(22);expect(result.sourceFiles).toBe(24);expect(result.chunks).toBe(491);
 expect(sha256(await readFile(new URL('../../../data/rag/qa.jsonl',import.meta.url),'utf8'))).toBe('0d7c9ff7be567cab8181b3f2d471c25eed5c909262639a484c43af183f1ee01f');
});
test('multiline Hugo shortcodes do not leak template attributes into corpus text',()=>{
 const result=normalize('A {{< glossary_tooltip\n text="Pod" term_id="pod" >}} runs.\n{{< feature-state\n for_k8s_version="v1.34" state="stable" >}}\nEnd.');
 expect(result.lines.map(x=>x.text).join('\n')).not.toMatch(/term_id|for_k8s_version|>}}/);
 expect(result.lines[0]).toEqual({line:1,text:'A Pod'});expect(result.omissions).toContainEqual({line:3,kind:'feature-state'});
});
test('caller-rehashed forged chunks cannot retain the official frozen version',async()=>{
 const {readFile}=await import('node:fs/promises');const {verifyCorpus,corpusLockDigest}=await import('../src/ingest.js');
 const lock=JSON.parse(await readFile(new URL('../../../data/rag/corpus.lock',import.meta.url),'utf8'));
 const chunks=(await readFile(new URL('../../../data/rag/chunks.jsonl',import.meta.url),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const first=chunks[0];first.text='FORGED'+first.text.slice(6);first.contentHash=sha256(first.text);first.id=sha256(JSON.stringify([first.version,first.docId,first.startOffset,first.endOffset,first.contentHash]));lock.chunksHash=sha256(JSON.stringify(chunks));
 expect(()=>verifyCorpus(lock,chunks)).toThrow('UNAPPROVED_CORPUS');
 expect(()=>verifyCorpus(lock,chunks,{scope:'fixture',expectedLockDigest:corpusLockDigest(lock)})).toThrow('UNAPPROVED_CORPUS');
});
test('failed INSERT and failed ROLLBACK retain incurred cost and both sanitized failures',async()=>{
 const {readFile}=await import('node:fs/promises');const {ingest}=await import('../src/ingest.js');
 const lock=JSON.parse(await readFile(new URL('../../../data/rag/corpus.lock',import.meta.url),'utf8'));
 const chunks=(await readFile(new URL('../../../data/rag/chunks.jsonl',import.meta.url),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const profile=embeddingProfile({alias:'fixture',provider:'openaiCompatible',model:'fixture',revision:'fixture',dimension:3,runtimeEvidence:'fixture-only'});
 const incurred={model:'fixture',provider:'openaiCompatible' as const,status:'success' as const,costUsd:.25,costStatus:'unknown' as const,attempts:[{attempt:1,outcome:'failed' as const,costStatus:'unknown' as const},{attempt:2,outcome:'success' as const,costStatus:'known' as const,costUsd:.25,usage:{input:1,output:0}}]};
 let embeds=0;const db={async query(sql:string){if(sql==='ROLLBACK')throw Object.assign(new Error('private rollback endpoint'),{code:'08006'});if(sql.startsWith('INSERT INTO chunks'))throw Object.assign(new Error('private insert data'),{code:'08003'});if(sql==='SELECT profile FROM rag_embedding_profiles WHERE id=$1')return{rows:[{profile}]};return{rows:[]};}};
 const error=await ingest(db as never,lock,chunks,{profile,async embed(texts){embeds++;return{profile,vectors:texts.map(()=>[1,0,0]),accounting:incurred};}},new AbortController().signal).catch(error=>error);
 expect(embeds).toBe(1);expect(error).toMatchObject({message:'INGEST_FAILED',calls:[incurred],primaryFailure:{stage:'insert-chunk',code:'08003'},cleanupFailure:{stage:'rollback',code:'08006'}});expect(JSON.stringify(error)).not.toMatch(/private rollback|private insert/);
});
test('verified ingestion snapshots caller artifacts before an asynchronous model wait',async()=>{
 const {readFile}=await import('node:fs/promises');const {ingest}=await import('../src/ingest.js');
 const lock=JSON.parse(await readFile(new URL('../../../data/rag/corpus.lock',import.meta.url),'utf8'));
 const chunks=(await readFile(new URL('../../../data/rag/chunks.jsonl',import.meta.url),'utf8')).trim().split('\n').map(line=>JSON.parse(line));const firstText=chunks[0].text;
 const profile=embeddingProfile({alias:'fixture',provider:'openaiCompatible',model:'fixture',revision:'fixture',dimension:3,runtimeEvidence:'fixture-only'});
 let release!:()=>void;const pause=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});let insertedText='';
 const db={async query(sql:string,values?:unknown[]){if(sql==='SELECT profile FROM rag_embedding_profiles WHERE id=$1')return{rows:[{profile}]};if(sql.startsWith('INSERT INTO chunks')){insertedText=values?.[5] as string;throw new Error('fixture stop after first insert');}return{rows:[]};}};
 const pending=ingest(db as never,lock,chunks,{profile,async embed(texts){entered();await pause;return{profile,vectors:texts.map(()=>[1,0,0]),accounting:{model:'fixture',provider:'openaiCompatible',status:'success',costUsd:0,costStatus:'unknown',attempts:[{attempt:1,outcome:'success',costStatus:'unknown'}]}};}},new AbortController().signal).catch(error=>error);
 await waiting;chunks[0].text='forged after verification';lock.version='forged after verification';release();await pending;expect(insertedText).toBe(firstText);
});
