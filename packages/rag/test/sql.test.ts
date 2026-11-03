import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { embeddingProfile } from 'models/rag';
import type { EmbeddingClient } from 'models/rag';
import { chunkDocument, ingest as ingestAdmitted, sha256, corpusLockDigest } from '../src/ingest.js';
import type { CorpusLock } from '../src/ingest.js';
import { createRetriever } from '../src/retrieve.js';
import { recallAtK } from '../src/eval.js';
import { createRagPipeline, createReranker } from '../src/rerank.js';
import type { ModelClient } from 'models/types';
// rag has no testcontainers dependency of its own; reuse the runtime suite's container helper.
import { postgres } from '../../runtime/test/postgres.js';
let db:Client;let admin:Client;let name:string;let container:Awaited<ReturnType<typeof postgres>>|undefined;
beforeAll(async()=>{
 container=await postgres('rag-tests');const url=container.getConnectionUri();
 admin=new Client({connectionString:url});await admin.connect();name='rag_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${name}"`);
 const target=new URL(url);target.pathname='/'+name;db=new Client({connectionString:target.href});await db.connect();
 await db.query(await readFile(new URL('../../db/migrations/0004_rag.up.sql',import.meta.url),'utf8'));
},120_000);
afterAll(async()=>{await db?.end();if(admin){try{if(name)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);}finally{await admin.end();}}await container?.stop();},60_000);
function ingest(...args: Parameters<typeof ingestAdmitted>) {
 return ingestAdmitted(...args.slice(0,5) as [typeof args[0],typeof args[1],typeof args[2],typeof args[3],typeof args[4]], {scope:'fixture',expectedLockDigest:corpusLockDigest(args[1])});
}
function corpus(){
 const source={path:'pods.md',url:'https://fixture.test/pods',gitBlobSha:'fixture',bytes:1,sha256:'fixture'};
 const spec={upstream:{repository:'fixture',commit:'fixture',rootTree:'fixture',release:'fixture'},license:'fixture',attribution:'fixture',modifiedNotice:'fixture',normalizer:'fixture-v1',maxChars:1200,sources:[source]};
 const version=sha256(JSON.stringify(spec));
 const chunks=['Pods contain containers and shared networking.','ConfigMaps store configuration data.','Services expose Pods over a network.'].map((text)=>chunkDocument(version,'pods.md',text,source.url)[0]!).map((c,i)=>({...c,id:sha256(JSON.stringify([c.version,c.docId,c.startOffset+i*100,c.endOffset+i*100,c.contentHash])),startOffset:c.startOffset+i*100,endOffset:c.endOffset+i*100}));
 const lock:CorpusLock={version,...spec,chunksHash:sha256(JSON.stringify(chunks)),chunkCount:chunks.length,omissions:[]};return{lock,chunks};
}
let physical=0;
function fixtureEmbedding(dimension=3):EmbeddingClient{
 const profile=embeddingProfile({alias:'fixture-'+dimension,provider:'openaiCompatible',model:'fixture-'+dimension,revision:'fixture-only',dimension,runtimeEvidence:'TEST_FIXTURE_NOT_A_MODEL'});
 return{profile,async embed(texts){physical++;return{profile,vectors:texts.map(t=>dimension===2?[1,0]:t.includes('ConfigMaps')?[0,1,0]:[1,0,0]),accounting:{model:profile.model,provider:'openaiCompatible',status:'success',costUsd:0,costStatus:'known',usage:{input:1,output:0},attempts:[{attempt:1,outcome:'success',costStatus:'known',costUsd:0,usage:{input:1,output:0}}]}};}};
}
test('goldChunkInTop10OnFixtures: actual SQL cosine+ts_rank_cd and RRF isolate mixed dimensions',async()=>{
 const{lock,chunks}=corpus();const embeddings=fixtureEmbedding();
 expect((await ingest(db,lock,chunks,embeddings,new AbortController().signal)).inserted).toBe(3);
 const afterFirst=physical;expect((await ingest(db,lock,chunks,embeddings,new AbortController().signal)).inserted).toBe(0);expect(physical).toBe(afterFirst);
 await ingest(db,lock,chunks,fixtureEmbedding(2),new AbortController().signal);
 const retrieve=createRetriever(db,lock.version,embeddings,10);const result=await retrieve('Pods containers',10);
 expect(result.chunks).toHaveLength(3);expect(recallAtK([chunks[0]!.id],result.chunks.map(c=>c.id),10)).toBe(1);expect(result.lexicalIds).toContain(chunks[0]!.id);expect(result.vectorIds).toHaveLength(3);
 expect((await createRetriever(db,'unrelated',embeddings,10)('Pods',10)).chunks).toEqual([]);
 for(const k of[0,-1,1.5,1001])await expect(retrieve('Pods',k)).rejects.toThrow('INVALID_K');
 await expect(db.query("INSERT INTO chunks(id,doc_id,version,profile_id,dimension,text,content_hash,provenance,embedding) SELECT id||'bad',doc_id,version,profile_id,dimension,text,content_hash,provenance,$1::vector FROM chunks WHERE version=$2 AND profile_id=$3",[JSON.stringify([1,0]),lock.version,embeddings.profile.id])).rejects.toMatchObject({code:'23514'});
 await expect(db.query("INSERT INTO chunks(id,doc_id,version,profile_id,dimension,text,content_hash,provenance,embedding) SELECT id||'dimension',doc_id,version,profile_id,2,text,content_hash,provenance,'[1,0]'::vector FROM chunks WHERE version=$1 AND profile_id=$2",[lock.version,embeddings.profile.id])).rejects.toMatchObject({code:'23503'});
});
test('ingest rolls back model failure and schema rollback/reapply leaves no objects',async()=>{
 const{lock,chunks}=corpus();const base=fixtureEmbedding(4);const failing:EmbeddingClient={profile:base.profile,async embed(){throw Object.assign(new Error('fixture'),{accounting:{costStatus:'unknown'}});}};
 await expect(ingest(db,lock,chunks,failing,new AbortController().signal)).rejects.toThrow('INGEST_FAILED');expect((await db.query('SELECT count(*)::int AS count FROM chunks WHERE profile_id=$1',[base.profile.id])).rows[0]?.count).toBe(0);
 await db.query(await readFile(new URL('../../db/migrations/0004_rag.down.sql',import.meta.url),'utf8'));
 expect((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
 await db.query(await readFile(new URL('../../db/migrations/0004_rag.up.sql',import.meta.url),'utf8'));
});
test('corpus and profile immutability prevents same identity being relabeled',async()=>{
 const{lock,chunks}=corpus();const embeddings=fixtureEmbedding();await ingest(db,lock,chunks,embeddings,new AbortController().signal);
 await expect(db.query("UPDATE rag_embedding_profiles SET profile=jsonb_set(profile,'{revision}','\"forged\"') WHERE id=$1",[embeddings.profile.id])).rejects.toMatchObject({code:'55000'});
 await expect(db.query('UPDATE rag_corpora SET lock=$1 WHERE version=$2',[{},lock.version])).rejects.toMatchObject({code:'55000'});
});
test('a later embedding batch failure rolls back earlier rows while retaining every call',async()=>{
 const{lock:original}=corpus();const spec={...original,modifiedNotice:'rollback-fixture'};const{version:_v,chunksHash:_h,chunkCount:_c,omissions:_o,...base}=spec;
 const version=sha256(JSON.stringify(base));const chunks=Array.from({length:33},(_,i)=>chunkDocument(version,'pods.md',`fixture batch row ${i}`,'https://fixture.test/pods')[0]!);
 const lock:CorpusLock={version,...base,chunksHash:sha256(JSON.stringify(chunks)),chunkCount:33,omissions:[]};const fixture=fixtureEmbedding();let calls=0;
 const failing:EmbeddingClient={profile:fixture.profile,async embed(texts,opts){calls++;if(calls===2)throw Object.assign(new Error('private fixture failure'),{accounting:{model:fixture.profile.model,provider:'openaiCompatible',status:'failed',costUsd:0,costStatus:'unknown',attempts:[{attempt:1,outcome:'failed',costStatus:'unknown'}]}});return fixture.embed(texts,opts);}};
 await expect(ingest(db,lock,chunks,failing,new AbortController().signal)).rejects.toMatchObject({message:'INGEST_FAILED',calls:[{status:'success'},{status:'failed',costStatus:'unknown'}]});
 expect((await db.query('SELECT count(*)::int AS count FROM chunks WHERE version=$1',[version])).rows[0]?.count).toBe(0);
 expect((await db.query('SELECT version FROM rag_corpora WHERE version=$1',[version])).rows).toEqual([]);
});

test('composed retrieve returns chunks after actual SQL candidates and model-layer reranking',async()=>{
 const{lock,chunks}=corpus();const embeddings=fixtureEmbedding();await ingest(db,lock,chunks,embeddings,new AbortController().signal);
 const scriptedModel:ModelClient={async *stream(){yield{text:'{"score":1}',accounting:{model:'fixture-score',provider:'openaiCompatible',status:'success',costUsd:0,costStatus:'known',usage:{input:1,output:1},attempts:[{attempt:1,outcome:'success',costStatus:'known',costUsd:0,usage:{input:1,output:1}}]}};}};
 const pipeline=createRagPipeline(createRetriever(db,lock.version,embeddings,10),createReranker(scriptedModel,{alias:'fixture',model:'fixture-score',revision:'fixture-only',runtimeEvidence:'TEST_FIXTURE_NOT_A_MODEL'}),10);
 const result=await pipeline.inspect('Pods containers',10);expect(result.calls).toHaveLength(4);expect(result.before.map(c=>c.id)).toEqual(result.after.map(c=>c.id));
 expect((await pipeline.retrieve('Pods containers',10)).every(c=>c.tainted===true)).toBe(true);
});
