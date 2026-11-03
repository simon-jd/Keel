/** Task 9 local judge run: every prompt version over every sample, then agreement with a reference.
 * run:       tsx judgeRun.ts run <samples.jsonl> <out-dir> [--rubric NAME] [--versions v1] [--concurrency N] [--max-tokens N]   (backend at 127.0.0.1:18080, token in KEEL_TOKEN_FILE)
 * summarize: tsx judgeRun.ts summarize <reference.jsonl> <out-dir> */
import {appendFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {agreement} from './agreement.js';
import {compareLabels} from './calibration.js';
import {createJudge,JudgeFailure,prompts,RUBRIC,RUBRICS,type Sample} from './judge.js';
export type JudgeRow={id:string;label:'pass'|'fail'|null;error:string|null;rationale?:string;latencyMs:number;usage:{input:number;output:number}|null};
type Judge=ReturnType<typeof createJudge>;
export async function judgeAll(judge:Judge,samples:Sample[],rubric:{version:string;text:string},write:(row:JudgeRow)=>void,concurrency=1){
 // Up to `concurrency` verdicts in flight (vLLM batches them); rows are written as they finish.
 let next=0;
 const worker=async()=>{
  while(next<samples.length){
   const sample=samples[next++]!,started=performance.now();
   try{const o=await judge.observe(sample,rubric);write({id:sample.id,label:o.verdict.label,error:null,rationale:o.verdict.rationale,latencyMs:performance.now()-started,usage:o.usage});}
   // A failed verdict stays a failure; it is never mapped to pass or fail.
   catch(error){write({id:sample.id,label:null,error:error instanceof JudgeFailure?error.code:'JUDGE_FAILED',latencyMs:performance.now()-started,usage:error instanceof JudgeFailure?error.evidence.usage:null});}
  }
 };
 await Promise.all(Array.from({length:Math.min(concurrency,samples.length)},worker));
}
export function summarize(reference:{id:string;label:string}[],predictions:Record<string,{id:string;label:string|null;error:string|null}[]>){
 const ids=reference.map(r=>r.id),truth=new Map(reference.map(r=>[r.id,r.label]));
 const labeled=Object.fromEntries(Object.entries(predictions).map(([v,rows])=>[v,rows.filter(r=>r.label!==null).map(r=>({id:r.id,label:r.label!}))]));
 const versions=Object.fromEntries(Object.entries(predictions).map(([v,rows])=>{
  const ok=labeled[v]!,errors:Record<string,number>={};for(const r of rows)if(r.error)errors[r.error]=(errors[r.error]??0)+1;
  const confusion={reference_pass_judge_pass:0,reference_pass_judge_fail:0,reference_fail_judge_pass:0,reference_fail_judge_fail:0};
  for(const r of ok)confusion[`reference_${truth.get(r.id)}_judge_${r.label}` as keyof typeof confusion]++;
  let kappaOnLabeled:number|null=null;try{kappaOnLabeled=agreement(ok.map(r=>truth.get(r.id)!),ok.map(r=>r.label)).kappa;}catch{kappaOnLabeled=null;}
  return [v,{labeled:ok.length,failed:rows.length-ok.length,errors,confusion,kappaOnLabeled}];
 }));
 return {reference:{n:ids.length,pass:reference.filter(r=>r.label==='pass').length,fail:reference.filter(r=>r.label==='fail').length},versions,selection:compareLabels(ids,reference,labeled)};
}
/** `[--rubric NAME] [--versions v1,v2] [--concurrency N] [--max-tokens N]`; defaults are the Task 9 calibration run. */
export function runOptions(args:string[]){
 let rubric:{version:string;text:string}=RUBRIC,versions:(keyof typeof prompts)[]=['v1','v2'],concurrency:number|undefined,maxTokens:number|undefined;
 const bounded=(value:string,max:number)=>{const n=Number(value);if(!/^[0-9]+$/.test(value)||!Number.isSafeInteger(n)||n<1||n>max)throw new Error('INVALID_RUN_OPTION');return n;};
 for(let i=0;i<args.length;i+=2){
  const [flag,value]=[args[i],args[i+1]??''];
  if(flag==='--rubric'){if(!Object.hasOwn(RUBRICS,value))throw new Error('UNKNOWN_RUBRIC');rubric=RUBRICS[value]!;}
  else if(flag==='--versions'){versions=value.split(',') as typeof versions;if(!versions.every(v=>Object.hasOwn(prompts,v)))throw new Error('UNKNOWN_PROMPT_VERSION');}
  else if(flag==='--concurrency')concurrency=bounded(value,16);
  else if(flag==='--max-tokens')maxTokens=bounded(value,4096);
  else throw new Error('UNKNOWN_OPTION');
 }
 return {rubric,versions,...(concurrency===undefined?{}:{concurrency}),...(maxTokens===undefined?{}:{maxTokens})};
}
const readJsonl=(path:string)=>readFileSync(path,'utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
async function main(){
 const [command,input,out,...rest]=process.argv.slice(2);
 if(command==='run'&&input&&out){
  const {rubric,versions,concurrency,maxTokens}=runOptions(rest);
  const token=readFileSync(process.env.KEEL_TOKEN_FILE??'.secrets/benchmark-token','utf8').trim();mkdirSync(out,{recursive:true});
  const samples=readJsonl(input) as Sample[];
  for(const version of versions)
   await judgeAll(createJudge({token,promptVersion:version,...(maxTokens===undefined?{}:{maxTokens})}),samples,rubric,row=>appendFileSync(join(out,`${version}.jsonl`),JSON.stringify(row)+'\n'),concurrency);
 }else if(command==='summarize'&&input&&out){
  const predictions=Object.fromEntries(Object.keys(prompts).filter(v=>existsSync(join(out,`${v}.jsonl`))).map(v=>[v,readJsonl(join(out,`${v}.jsonl`))]));
  process.stdout.write(JSON.stringify(summarize(readJsonl(input),predictions),null,1)+'\n');
 }else{process.stderr.write('usage: judgeRun.ts run <samples.jsonl> <out-dir> | summarize <reference.jsonl> <out-dir>\n');process.exitCode=2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
