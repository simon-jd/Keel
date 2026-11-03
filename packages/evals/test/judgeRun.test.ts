import {expect,test} from 'vitest';
import {createJudge,RUBRIC,RUBRICS} from '../src/judge.js';
import {judgeAll,runOptions,summarize} from '../src/judgeRun.js';
const samples=['a','b','c'].map(id=>({id,input:{messages:[{role:'user',content:id}],tools:[]},action:{role:'assistant',content:id,toolCalls:[]}}));
function reply(content:string){return new Response(JSON.stringify({action:{role:'assistant',content,toolCalls:[]},invalidToolCalls:[],run_id:'r',call_id:'c',accounting:null,usage:{input:10,output:5}}));}
test('judgeAll keeps every sample: verdicts, and failures with their code instead of a guessed label',async()=>{
 const outputs:Record<string,string>={a:'{"label":"pass","rationale":"ok"}',b:'```json\n{"label":"fail","rationale":"x"}\n```',c:'{"label":"fail","rationale":"wrong value"}'};
 const judge=createJudge({token:'x'.repeat(32),promptVersion:'v2',fetch:async(_url,init)=>reply(outputs[JSON.parse(String(init!.body)).messages[1].content.match(/"content":"(\w)"/)[1]]!)});
 const rows:unknown[]=[];await judgeAll(judge,samples,RUBRIC,row=>rows.push(row));
 expect(rows).toMatchObject([{id:'a',label:'pass',error:null,usage:{input:10,output:5}},{id:'b',label:null,error:'INVALID_JUDGE_SCHEMA'},{id:'c',label:'fail',error:null}]);
 expect((rows as {latencyMs:number}[]).every(r=>r.latencyMs>=0)).toBe(true);
});
test('summarize applies the predeclared selection and reports kappa on the labeled subset separately',()=>{
 const reference=[{id:'a',label:'pass'},{id:'b',label:'fail'},{id:'c',label:'fail'},{id:'d',label:'pass'}];
 const full={v1:reference.map(r=>({id:r.id,label:r.label==='pass'?'pass':'fail'})),v2:reference.map(r=>({id:r.id,label:'pass'}))};
 const report=summarize(reference,{v1:full.v1.map(r=>({...r,error:null})),v2:full.v2.map(r=>({...r,error:null}))});
 expect(report.selection.selected).toBe('v1');expect(report.versions.v1).toMatchObject({labeled:4,failed:0,kappaOnLabeled:1});
 expect(report.versions.v2?.confusion).toEqual({reference_pass_judge_pass:2,reference_pass_judge_fail:0,reference_fail_judge_pass:2,reference_fail_judge_fail:0});
 const partial=summarize(reference,{v1:[...full.v1.slice(0,3).map(r=>({...r,error:null})),{id:'d',label:null,error:'INVALID_JUDGE_SCHEMA'}],v2:full.v2.map(r=>({...r,error:null}))});
 // Incomplete coverage blocks the predeclared selection; the subset kappa is still reported.
 expect(partial.selection.selected).toBeNull();expect(partial.versions.v1).toMatchObject({labeled:3,failed:1,errors:{INVALID_JUDGE_SCHEMA:1},kappaOnLabeled:1});
});
test('run options default to the Task 9 rubric and every prompt version; a named rubric and version list are honoured',()=>{
 expect(runOptions([])).toEqual({rubric:RUBRIC,versions:['v1','v2']});
 expect(runOptions(['--rubric','kubernetes-grounding-binary-v1','--versions','v1'])).toEqual({rubric:RUBRICS['kubernetes-grounding-binary-v1'],versions:['v1']});
 expect(()=>runOptions(['--rubric','nope'])).toThrow('UNKNOWN_RUBRIC');
 expect(()=>runOptions(['--versions','v9'])).toThrow('UNKNOWN_PROMPT_VERSION');
 expect(runOptions(['--versions','v1,v2,v3','--concurrency','8','--max-tokens','4096'])).toEqual({rubric:RUBRIC,versions:['v1','v2','v3'],concurrency:8,maxTokens:4096});
 for(const bad of [['--concurrency','0'],['--concurrency','17'],['--max-tokens','4097'],['--max-tokens','x']])expect(()=>runOptions(bad)).toThrow('INVALID_RUN_OPTION');
});
test('judgeAll with concurrency keeps one row per sample and never exceeds the in-flight bound',async()=>{
 let active=0,peak=0;const many=Array.from({length:20},(_,i)=>({id:`s${i}`,input:{messages:[{role:'user',content:`s${i}`}],tools:[]},action:{role:'assistant',content:'x',toolCalls:[]}}));
 const judge=createJudge({token:'x'.repeat(32),maxTokens:4096,fetch:async(_url,init)=>{
  expect(JSON.parse(String(init!.body)).maxTokens).toBe(4096);
  active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return reply('{"label":"pass","rationale":"ok"}');}});
 const rows:{id:string;label:string|null}[]=[];await judgeAll(judge,many,RUBRIC,row=>rows.push(row),4);
 expect(rows.map(r=>r.id).sort()).toEqual(many.map(s=>s.id).sort());expect(rows.every(r=>r.label==='pass')).toBe(true);
 expect(peak).toBeLessThanOrEqual(4);expect(peak).toBeGreaterThan(1);
});
test('summarize reads only the versions that were run',()=>{
 const reference=[{id:'a',label:'pass'},{id:'b',label:'fail'}];
 const report=summarize(reference,{v3:[{id:'a',label:'pass',error:null},{id:'b',label:'fail',error:null}]});
 expect(Object.keys(report.versions)).toEqual(['v3']);expect(report.versions.v3).toMatchObject({labeled:2,failed:0,kappaOnLabeled:1});
});
