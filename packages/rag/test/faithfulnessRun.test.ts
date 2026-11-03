import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import {ANSWER_PROMPT,answerAll,judgeSamples,prepareFromRuns,prepareRows,summarizeFaithfulness} from '../src/faithfulnessRun.js';
import {GROUNDING_RUBRIC} from '../src/actualCalibration.js';
import {RUBRICS} from '../../evals/src/judge.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const chunks=Array.from({length:12},(_,i)=>({id:`c${i}`,text:`text ${i}`}));
const qa=[{id:'q1',question:'What is one?',goldChunkIds:['c0']},{id:'q2',question:'What is two?',goldChunkIds:['c11']}];
const byIds=(ids:string[])=>ids.map(id=>({id,text:chunks.find(c=>c.id===id)!.text}));
const beforeIds=chunks.slice(0,12).map(c=>c.id),afterIds=['c11',...beforeIds.slice(0,9)];
function records(){
 return qa.flatMap((q,index)=>[
  {kind:'paired',index,before:beforeIds.map(id=>({id,rrfScore:0.01})),afterIds},
  {kind:'answer',index,questionId:q.id,answer:`stored ${q.id}`,answerInputSha256:sha(JSON.stringify({question:q.question,contexts:byIds(afterIds)}))},
 ]);
}

test('the answer prompt and grounding rubric are the ones the stored 200-answer run used',()=>{
 expect(sha(ANSWER_PROMPT)).toBe('a4340dfdf9b78256949d4362ad8f8b43f48cf8da46f3524a0a8daeeba789aaf9');
 expect(RUBRICS['kubernetes-grounding-binary-v1']).toEqual(GROUNDING_RUBRIC);
});

test('prepareRows rebuilds before/after top-10 contexts and checks them against the stored answer input hash',()=>{
 const rows=prepareRows(records(),chunks,qa);
 expect(rows).toHaveLength(2);
 expect(rows[0]!.before.map(c=>c.id)).toEqual(beforeIds.slice(0,10));
 expect(rows[0]!.after.map(c=>c.id)).toEqual(afterIds);
 expect(rows[0]).toMatchObject({id:'q1',storedAfterAnswer:'stored q1',goldInBefore:true,goldInAfter:true});
 expect(rows[1]).toMatchObject({goldInBefore:false,goldInAfter:true});
 const tampered=records();(tampered[1] as {answerInputSha256:string}).answerInputSha256='0'.repeat(64);
 expect(()=>prepareRows(tampered,chunks,qa)).toThrow('STORED_ANSWER_INPUT_MISMATCH');
});

test('answerAll sends the stored answer protocol for both conditions and keeps failures as failures',async()=>{
 const rows=prepareRows(records(),chunks,qa),bodies:Record<string,unknown>[]=[];
 const fetcher:typeof fetch=async(_url,init)=>{
  const body=JSON.parse(String(init!.body));bodies.push(body);
  if(bodies.length===2)return new Response(JSON.stringify({error:'MODEL_FAILED'}),{status:502});
  return new Response(JSON.stringify({action:{role:'assistant',content:`answer ${bodies.length}`,toolCalls:[]},usage:{input:7,output:3}}));
 };
 const out:unknown[]=[];await answerAll({token:'x'.repeat(32),fetch:fetcher},rows,row=>out.push(row));
 expect(bodies).toHaveLength(4);
 expect(bodies[0]).toMatchObject({model:'local',tools:[],temperature:0,seed:0,maxTokens:512});
 expect((bodies[0]!.messages as {content:string}[])[0]!.content).toBe(ANSWER_PROMPT);
 expect((bodies[0]!.messages as {content:string}[])[1]!.content).toBe(JSON.stringify({question:'What is one?',contexts:rows[0]!.before}));
 expect((bodies[1]!.messages as {content:string}[])[1]!.content).toBe(JSON.stringify({question:'What is one?',contexts:rows[0]!.after}));
 expect(out).toMatchObject([{id:'q1',condition:'before',answer:'answer 1',error:null,usage:{input:7,output:3}},{id:'q1',condition:'after',answer:null,error:'HTTP_502:MODEL_FAILED'},{id:'q2',condition:'before'},{id:'q2',condition:'after',answer:'answer 4'}]);
});

test('answerAll resumes: rows already written (answers or failures) are not sent again',async()=>{
 const rows=prepareRows(records(),chunks,qa),sent:string[]=[];
 const fetcher:typeof fetch=async(_url,init)=>{sent.push(JSON.parse(String(init!.body)).messages[1].content);return new Response(JSON.stringify({action:{role:'assistant',content:'x',toolCalls:[]},usage:null}));};
 const out:{id:string;condition:string}[]=[];
 await answerAll({token:'x'.repeat(32),fetch:fetcher},rows,row=>out.push(row),new Set(['q1:before','q1:after','q2:before']));
 expect(out.map(r=>`${r.id}:${r.condition}`)).toEqual(['q2:after']);expect(sent).toHaveLength(1);
});

test('judgeSamples pairs each answer with the contexts it was generated from; summarize keeps failed rows in the denominator',()=>{
 const rows=prepareRows(records(),chunks,qa);
 const answers=[{id:'q1',condition:'before',answer:'b1',error:null},{id:'q1',condition:'after',answer:null,error:'HTTP_502:X'},{id:'q2',condition:'before',answer:'b2',error:null},{id:'q2',condition:'after',answer:'a2',error:null}];
 const samples=judgeSamples(rows,answers as never);
 expect(samples.map(s=>s.id)).toEqual(['q1:stored','q1:before','q2:stored','q2:before','q2:after']);
 expect(samples[1]).toEqual({id:'q1:before',input:{question:'What is one?',contexts:rows[0]!.before},action:{answer:'b1'}});
 expect(samples[0]!.input).toEqual({question:'What is one?',contexts:rows[0]!.after});
 const verdicts=[{id:'q1:stored',label:'pass',error:null},{id:'q1:before',label:'fail',error:null},{id:'q2:stored',label:'pass',error:null},{id:'q2:before',label:null,error:'INVALID_JUDGE_SCHEMA'},{id:'q2:after',label:'pass',error:null}];
 const report=summarizeFaithfulness(rows,answers as never,verdicts as never);
 expect(report.conditions.stored).toMatchObject({n:2,faithful:2,answerFailed:0,judgeFailed:0,rate:1});
 expect(report.conditions.before).toMatchObject({n:2,faithful:0,answerFailed:0,judgeFailed:1,rate:0});
 expect(report.conditions.after).toMatchObject({n:2,faithful:1,answerFailed:1,judgeFailed:0,rate:0.5});
 // Paired before→after only where both sides have a verdict.
 expect(report.paired).toEqual({both:0,improved:0,degraded:0,tied:0});
 expect(report.byGold.after.goldRetrieved).toMatchObject({n:2,faithful:1});
});
test('prepareFromRuns takes before = hybrid top-10 and after = hybrid+LLM rerank top-10 of a stored retrieval run; no stored answer',()=>{
 const runs={hybrid:{q1:beforeIds,q2:[...beforeIds].reverse()},'hybrid+llm':{q1:afterIds,q2:beforeIds}};
 const rows=prepareFromRuns(runs,chunks,qa);
 expect(rows[0]).toEqual({id:'q1',question:'What is one?',before:byIds(beforeIds.slice(0,10)),after:byIds(afterIds.slice(0,10)),storedAfterAnswer:null,goldInBefore:true,goldInAfter:true});
 expect(rows[1]).toMatchObject({goldInBefore:true,goldInAfter:false});
 expect(()=>prepareFromRuns({hybrid:{q1:beforeIds},'hybrid+llm':{q1:afterIds}},chunks,qa)).toThrow('MISSING_RUN');
 const answers=[{id:'q1',condition:'before',answer:'b1',error:null},{id:'q1',condition:'after',answer:'a1',error:null}];
 // Without a stored answer there is no stored sample and no stored condition in the summary.
 expect(judgeSamples(rows.slice(0,1),answers as never).map(s=>s.id)).toEqual(['q1:before','q1:after']);
 const report=summarizeFaithfulness(rows.slice(0,1),answers as never,[{id:'q1:before',label:'pass',error:null},{id:'q1:after',label:'fail',error:null}] as never);
 expect(Object.keys(report.conditions)).toEqual(['before','after']);
 expect(report.paired).toEqual({both:1,improved:0,degraded:1,tied:0});
});
