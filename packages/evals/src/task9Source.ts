/** Shared anchored Task9 source and private artifact IO. No model calls or CLI side effects. */
import {constants,closeSync,existsSync,fstatSync,fsyncSync,lstatSync,openSync,readSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {agentReferenceReport,validateAgentLabels} from './agentReference.js';
import {canonical,hash,prompts,RUBRIC} from './judge.js';
import type {Sample} from './judge.js';
export type Role='primary'|'secondary';
export type Metadata={schema:number;primaryIds:string[];secondaryIds:string[];primaryHash:string;secondaryHash:string;auditHash:string;cohortHash:string;rubricVersion:string;rubricHash:string;promptVersions:string[];promptHashes:Record<string,string>;protocol:string;population:number;selection:string;manifestSha256:string;sourceSnapshotSha256:string;sourceSnapshotBytes:number;implementationSha256:string;indexSha256:string};
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export const DIRECTORY=join(ROOT,'.tools/annotation-task9');
export const FROZEN_COHORT_HASH='c48c6dff2d6d594125b0260682d31d5a2d1c68ca3448af689cc69d1406e1699f';
const FROZEN_BINDINGS={protocol:'bfcl-single-turn-v1',population:400,selection:'sha256(bfcl-single-turn-v1:primary:contentHash), lexical ascending; secondary uses secondary salt',manifestSha256:'b1bc00fb3fc6dfc2261e7a660026dc9e49e6fd69c547d1287efd9fc56b9db38a',sourceSnapshotSha256:'3fbacb6de864310bc707970ff99979a7e133cdb8a36ffea775ac5526f86f490a',sourceSnapshotBytes:10780899,implementationSha256:'864bcdb6dbaeb31487173c3a0f6697af401ca9c19d5fd08612f3db24516c44f1',indexSha256:'851e8b6b36a1033b7bfe5bfc82ca39104702f4f79ebaa78c7bd959537858296f'} as const;
const fixtureDirectories=new Set<string>();
/** Disposable Vitest directories only. The production CLI never calls this entry point. */
export function registerFixtureWorkspaceForTests(directory:string){
 requireValue(process.env.NODE_ENV==='test'&&process.env.VITEST==='true'&&dirname(resolve(directory))===resolve(tmpdir())&&/^keel-annotation-fixture-/.test(directory.slice(directory.lastIndexOf('/')+1)),'FIXTURE_ADMISSION_UNAVAILABLE');
 owned(directory,true);fixtureDirectories.add(directory);
}

export function requireValue(condition:unknown,code:string):asserts condition{if(!condition)throw new Error(code);}
function parents(path:string){for(let p=dirname(resolve(path));;p=dirname(p)){requireValue(!lstatSync(p).isSymbolicLink(),'SYMLINK_PARENT');if(dirname(p)===p)break;}}
export function owned(path:string,directory=false){
 parents(path);const info=lstatSync(path);requireValue(info.uid===process.getuid?.()&&!info.isSymbolicLink()&&(directory?info.isDirectory():info.isFile())&&(info.mode&0o777)===(directory?0o700:0o600),'PRIVATE_OWNED_FILE_REQUIRED');return info;
}
export function readPrivate(path:string,limit=8_000_000){
 const info=owned(path);requireValue(info.size<=limit,'PRIVATE_FILE_LIMIT');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const actual=fstatSync(fd);requireValue(actual.ino===info.ino&&actual.dev===info.dev,'FILE_CHANGED');const value=Buffer.alloc(Math.min(info.size+1,limit+1));let size=0;while(size<value.length){const count=readSync(fd,value,size,value.length-size,null);if(!count)break;size+=count;}requireValue(size===info.size&&size<=limit,'PRIVATE_FILE_LIMIT');return value.subarray(0,size).toString('utf8');}finally{closeSync(fd);}
}
export function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
export function writePrivate(path:string,value:string){
 owned(dirname(path),true);const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(dirname(path));
}
export function replacePrivate(path:string,value:string){owned(path);const temp=join(dirname(path),`.write-${randomUUID()}`);writePrivate(temp,value);renameSync(temp,path);syncDirectory(dirname(path));}
export function readSecret(path:string){const token=readPrivate(resolve(path),4096).trim();requireValue(token.length>=32&&!/[\r\n]/.test(token),'INVALID_TOKEN_FILE');return token;}
export function rows(text:string):unknown[]{return text.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));}
export function serialize(value:unknown[]){return value.map(canonical).map(line=>`${line}\n`).join('');}
export function role(value:string|undefined):Role{requireValue(value==='primary'||value==='secondary','ROLE_MUST_BE_PRIMARY_OR_SECONDARY');return value;}
export function loadCohort(directory=DIRECTORY){
 owned(directory,true);const metadata=JSON.parse(readPrivate(join(directory,'cohort.json'),131072)) as Metadata;
 if(!fixtureDirectories.has(directory))requireValue(metadata.cohortHash===FROZEN_COHORT_HASH&&Object.entries(FROZEN_BINDINGS).every(([key,value])=>metadata[key as keyof Metadata]===value)&&metadata.primaryIds?.length===300&&metadata.secondaryIds?.length===100,'FROZEN_COHORT_REQUIRED');
 const {cohortHash,...binding}=metadata;requireValue(metadata.schema===1&&hash(canonical(binding))===cohortHash&&metadata.rubricVersion===RUBRIC.version&&canonical(metadata.promptVersions)===canonical(['v1','v2'])&&metadata.rubricHash===hash(canonical(RUBRIC))&&canonical(metadata.promptHashes)===canonical({v1:hash(prompts.v1),v2:hash(prompts.v2)}),'COHORT_BINDING');
 const primaryText=readPrivate(join(directory,'primary.blind.jsonl')),secondaryText=readPrivate(join(directory,'secondary.blind.jsonl'));
 requireValue(hash(primaryText)===metadata.primaryHash&&hash(secondaryText)===metadata.secondaryHash&&hash(readPrivate(join(directory,'source.audit.json')))===metadata.auditHash,'MATERIAL_HASH_DRIFT');
 const primary=rows(primaryText) as Sample[],secondary=rows(secondaryText) as Sample[];
 for(const [samples,ids] of [[primary,metadata.primaryIds],[secondary,metadata.secondaryIds]] as const){
  requireValue(canonical(samples.map(s=>s.id))===canonical(ids)&&new Set(ids).size===ids.length,'COHORT_ID_DRIFT');
  requireValue(samples.every(s=>Object.keys(s).sort().join(',')==='action,id,input'),'BLIND_SCHEMA');
 }
 requireValue(new Set(primary.map(s=>hash(canonical({input:s.input,action:s.action})))).size===primary.length,'DUPLICATE_COHORT_CONTENT');
 const byId=new Map(primary.map(s=>[s.id,canonical(s)]));requireValue(secondary.every(s=>byId.get(s.id)===canonical(s)),'SECONDARY_NOT_SUBSET');
 return {metadata,primary,secondary};
}
export const AGENT_DIRECTORY=join(ROOT,'.tools/annotation-subagent-20261025');
export const AGENT_SOURCE_HASHES={primary:'1350432881dc718cda5d48b7065c09d5c20a315c493f3665a67f783737bfc3cf',secondary:'db8bdc15d285b7e81a69d9c86c83c866323ed01c3749e36cf8600fc4ec83e5dd'} as const;
const agentAttribution={model:'gpt-6.1-sol',reasoning_effort:'high',temperature:'unknown',per_call_cost:'unknown',source:'coordinator handoff; not independently verified per-call configuration'} as const;
function agentSources(directory:string,sourceDirectory:string){
 const cohort=loadCohort(directory);owned(sourceDirectory,true);
 const fixture=fixtureDirectories.has(directory);requireValue(fixture?sourceDirectory===join(directory,'agent-source'):sourceDirectory===AGENT_DIRECTORY,'FIXED_AGENT_SOURCE_REQUIRED');
 const primaryText=readPrivate(join(sourceDirectory,'primary.agent-labels.jsonl')),secondaryText=readPrivate(join(sourceDirectory,'secondary.agent-labels.jsonl'));
 const sourceHashes={primary:hash(primaryText),secondary:hash(secondaryText)};
 if(!fixture)requireValue(canonical(sourceHashes)===canonical(AGENT_SOURCE_HASHES),'AGENT_SOURCE_HASH_DRIFT');
 const inputHashes=new Map(readPrivate(join(directory,'primary.blind.jsonl')).split('\n').filter(Boolean).map(line=>[JSON.parse(line).id as string,hash(line)]));
 const primary=validateAgentLabels(rows(primaryText),cohort.metadata.primaryIds,cohort.metadata.cohortHash,RUBRIC.version,inputHashes),secondary=validateAgentLabels(rows(secondaryText),cohort.metadata.secondaryIds,cohort.metadata.cohortHash,RUBRIC.version,inputHashes);
 const summary={schema:1,cohortHash:cohort.metadata.cohortHash,sourceHashes,sourceAttribution:agentAttribution,...agentReferenceReport(cohort.metadata.primaryIds,cohort.metadata.secondaryIds,primary,secondary),nonblind_adjudications:'excluded; three original disagreements preserved separately'};
 requireValue(summary.accepted_user_substitution,'COMPLETE_AGENT_REFERENCE_REQUIRED');
 return {cohort,primary,secondary,summary};
}
/** Writes only a new source audit; the original 300/100 JSONL and human files stay untouched. */
export function importAgentReference(directory=DIRECTORY,sourceDirectory=AGENT_DIRECTORY){
 const reference=agentSources(directory,sourceDirectory),record={...reference.summary,importedAt:new Date().toISOString()};
 writePrivate(join(directory,'agent-reference.json'),canonical(record)+'\n');return record;
}
export function readAgentReference(directory=DIRECTORY,sourceDirectory=AGENT_DIRECTORY){
 const reference=agentSources(directory,sourceDirectory),path=join(directory,'agent-reference.json');requireValue(existsSync(path),'AGENT_REFERENCE_IMPORT_REQUIRED');
 const record=JSON.parse(readPrivate(path)),{importedAt,...binding}=record;
 requireValue(typeof importedAt==='string'&&Number.isFinite(Date.parse(importedAt))&&canonical(binding)===canonical(reference.summary),'AGENT_REFERENCE_AUDIT_MISMATCH');
 return {...reference,auditHash:hash(canonical(record))};
}
