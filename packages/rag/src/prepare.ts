import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { NORMALIZER, MAX_CHARS, sha256, chunkDocument, normalize, verifyCorpus } from './ingest.js';
import type { SourceFile, CorpusLock } from './ingest.js';
/** Offline only. Sources must already exist and match every pinned raw hash/blob/length. */
export async function prepareCorpus(directory: string, check = false) {
  const manifest=JSON.parse(await readFile(join(directory,'source-manifest.json'),'utf8')) as {repository:string;commit:string;rootTree:string;release:string;files:SourceFile[]};
  const spec={upstream:{repository:manifest.repository,commit:manifest.commit,rootTree:manifest.rootTree,release:manifest.release},license:'CC-BY-4.0',attribution:'The Kubernetes Authors',modifiedNotice:'Modified by Keel: YAML and comments removed; shortcode wrappers removed; explicit glossary text retained; unresolved includes/templates omitted and recorded. Markdown is not rendered HTML.',normalizer:NORMALIZER,maxChars:MAX_CHARS,sources:manifest.files};
  const version=sha256(JSON.stringify(spec));const chunks:ReturnType<typeof chunkDocument>=[];const omissions:CorpusLock['omissions']=[];
  for(const source of manifest.files){
    if(!/^(?:LICENSE|README\.md|content\/en\/docs\/concepts\/[a-z0-9_./-]+\.md)$/.test(source.path)||source.path.includes('..'))throw new Error('INVALID_SOURCE_PATH');
    const raw=await readFile(join(directory,'source',source.path));
    const blob=createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
    if(raw.length!==source.bytes||sha256(raw)!==source.sha256||blob!==source.gitBlobSha)throw new Error('SOURCE_INTEGRITY_FAILED');
    if(!source.path.startsWith('content/'))continue;
    const markdown=raw.toString('utf8');chunks.push(...chunkDocument(version,source.path,markdown,source.url));
    omissions.push(...normalize(markdown).omissions.map(o=>({docId:source.path,...o})));
  }
  const lock:CorpusLock={version,...spec,chunksHash:sha256(JSON.stringify(chunks)),chunkCount:chunks.length,omissions};verifyCorpus(lock,chunks);
  const artifacts={'corpus.lock':JSON.stringify(lock,null,2)+'\n','chunks.jsonl':chunks.map(c=>JSON.stringify(c)).join('\n')+'\n'};
  for(const [name,body] of Object.entries(artifacts)) {
    if(check){if(await readFile(join(directory,name),'utf8')!==body)throw new Error('FROZEN_CORPUS_CHANGED');}
    else {await mkdir(directory,{recursive:true});await writeFile(join(directory,name),body);}
  }
  return {sourceFiles:manifest.files.length,documents:manifest.files.filter(f=>f.path.startsWith('content/')).length,version,chunks:chunks.length,omissions:omissions.length,chunksHash:lock.chunksHash};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=fileURLToPath(new URL('../../../data/rag/',import.meta.url));
  console.log(JSON.stringify(await prepareCorpus(directory,process.argv.includes('--check'))));
}
