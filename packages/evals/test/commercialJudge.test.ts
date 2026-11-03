import {expect,it} from 'vitest';
import {runCommercialJudge} from '../src/commercialJudge.js';
import {canonical,hash} from '../src/judge.js';
import type {ModelClient} from '../../models/src/types.js';
const samples=Array.from({length:300},(_,i)=>({id:`fixture-${i}`,input:{ask:i},action:{answer:i}}));
const jobs=Array.from({length:605},(_,i)=>({logical:i,kind:i<5?'reproduce':'judge',promptVersion:i<305?'v1':'v2',sampleId:samples[i<5?0:(i-5)%300]!.id,requestHash:'a'.repeat(64)}));
const binding={phase:'task9-agent-judge-azure-mini-v1',deployment:'keel-judge-gpt41mini-20250414',model:'gpt-4.1-mini',version:'2025-04-14',jobs};
function fixture(invalidAt:number[]=[]){
 let physical=0;const client:ModelClient={async *stream(_request,opts){
  const n=physical++,invalid=invalidAt.includes(n),text=invalid?'malformed verdict':JSON.stringify({label:'fail',rationale:'full rationale '+ 'x'.repeat(700)});
  yield {text,providerResponse:{raw:canonical({transport:n,text}),complete:true,settlementStatus:'validated',dispatch:{startedAtMonotonicMs:n*4000,intervalMs:n?4000:null}},usage:{input:2,output:3},accounting:{model:binding.deployment,provider:'azureCommercial',status:'success',usage:{input:2,output:3},costUsd:(2*0.4+3*1.6)/1e6,costStatus:'known',attempts:[{attempt:1,outcome:'success',costStatus:'known',usage:{input:2,output:3},costUsd:(2*0.4+3*1.6)/1e6}],...(opts.run_id===undefined?{}:{run_id:opts.run_id}),...(opts.call_id===undefined?{}:{call_id:opts.call_id})}};
 }};
 const profile={binding,cohort:{primary:samples,metadata:{primaryIds:samples.map(s=>s.id)}},reference:{primary:samples.map((s,i)=>({id:s.id,label:i%2?'pass':'fail',origin:'subagent'})),summary:{reference_origin:'subagent',human_evidence:false,human_reference_gate_fulfilled:false}}};
 return {client,profile,pricing:{inputPerMillion:0.4,outputPerMillion:1.6},physical:()=>physical};
}
it('605 complete observations preserve raw/action/verdict comparisons and weak reference flags',async()=>{
 const f=fixture(),events:unknown[]=[];
 const r=await runCommercialJudge({...f,profile:f.profile as never,checkpoint:e=>{events.push(e);}});
 expect(r.status).toBe('completed');expect(r.physicalAttempts).toBe(605);expect(r.logicalCompleted).toBe(605);expect(f.physical()).toBe(605);
 expect(r.reproduction).toMatchObject({rawEqual:false,semanticEqual:true,verdictsEqual:true,labelsEqual:true});
 expect(r.calibration).toMatchObject({status:'compared',reference_origin:'subagent',human_evidence:false,human_reference_gate_fulfilled:false});
 expect(r.attempts[0]?.observation?.verdict.rationale.length).toBeGreaterThan(700);expect(events).toHaveLength(1210);
 expect(r.attempts[0]?.observation?.rawResponseHash).toBe(hash(canonical({transport:0,text:JSON.stringify({label:'fail',rationale:'full rationale '+'x'.repeat(700)})})));
});
it('known malformed judge recovery retains invalid denominator and cost; valid adverse verdict never retries',async()=>{
 const f=fixture([5,6]);const r=await runCommercialJudge({...f,profile:f.profile as never,checkpoint:()=>{}});
 expect(r.status).toBe('completed');expect(r.invalidSchemaCount).toBe(2);expect(r.physicalAttempts).toBe(607);expect(r.logicalCompleted).toBe(605);expect(r.invalidSchemaRate).toBe(2/607);
 expect(r.attempts.slice(5,8).map(a=>[a.logical,a.outcome])).toEqual([[5,'invalid-schema'],[5,'invalid-schema'],[5,'valid']]);
 expect(r.knownCostUsd).toBeCloseTo(607*0.0000056,12);
});
it('invalid reproduction stops without retries and partial cohort cannot calibrate',async()=>{
 const f=fixture([2]);const r=await runCommercialJudge({...f,profile:f.profile as never,checkpoint:()=>{}});
 expect(r.status).toBe('failed');expect(f.physical()).toBe(3);expect(r.logicalCompleted).toBe(2);expect(r.calibration).toBeNull();expect(r.reproduction).toBeNull();
 expect(r.attempts[2]).toMatchObject({outcome:'invalid-schema',rawResponse:expect.any(String),accounting:{costStatus:'known'}});
});
it('intent durability failure dispatches nothing and unknown accounting halts once',async()=>{
 const f=fixture();await expect(runCommercialJudge({...f,profile:f.profile as never,checkpoint:()=>{throw new Error('disk full');}})).rejects.toThrow('disk full');expect(f.physical()).toBe(0);
 const unknown:ModelClient={async *stream(){yield {text:'{}',providerResponse:{raw:'raw unknown'},accounting:{model:binding.deployment,provider:'azureCommercial',status:'success',costUsd:0,costStatus:'unknown',attempts:[{attempt:1,outcome:'success',costStatus:'unknown'}]}};}};
 const r=await runCommercialJudge({client:unknown,pricing:f.pricing,profile:f.profile as never,checkpoint:()=>{}});expect(r.physicalAttempts).toBe(1);expect(r.status).toBe('failed');expect(r.costStatus).toBe('unknown');expect(r.calibration).toBeNull();
});
it('a partial raw response cannot count as a complete commercial observation',async()=>{
 const f=fixture();const client:ModelClient={async *stream(req,opts){for await(const chunk of f.client.stream(req,opts))yield {...chunk,providerResponse:{...chunk.providerResponse!,complete:false}};}};
 const r=await runCommercialJudge({...f,client,profile:f.profile as never,checkpoint:()=>{}});expect(r.status).toBe('failed');expect(r.logicalCompleted).toBe(0);expect(r.calibration).toBeNull();expect(r.attempts[0]?.rawResponse).not.toBeNull();
});
