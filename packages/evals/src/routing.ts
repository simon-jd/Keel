import {randomUUID} from 'node:crypto';
import {createRouter,ModelError} from '../../models/src/router.js';
import type {AttemptAccounting,CallAccounting,ChatChunk,ChatRequest,Route} from '../../models/src/types.js';
export type Decision = {pass:boolean;confidence:number;source:'verifier'} | {pass:boolean;confidence:null;source:'unavailable'};
export type RoutingBudget = {maxCostUsd:number;maxAttempts:number;timeoutMs:number;reservePerAttemptUsd:{cheap:number;strong:number}};
export type RoutingRecord = {stage:'cheap'|'strong';accounting:CallAccounting};
type Reason = 'budget'|'unknown_cost'|'aborted'|'timeout'|'verifier'|'model';
/** Known cost is a subtotal when costStatus is unknown; never a fabricated total. */
export class RoutingFailure extends Error {
  readonly knownCostUsd:number;
  readonly costStatus:'known'|'unknown';
  readonly records:RoutingRecord[];
  constructor(readonly reason:Reason,records:RoutingRecord[]) {
    super(`Routing failed (${reason})`);this.records=structuredClone(records);
    this.knownCostUsd=records.reduce((s,r)=>s+r.accounting.costUsd,0);
    this.costStatus=records.some(r=>r.accounting.costStatus==='unknown')?'unknown':'known';
  }
}
const nonnegative=(x:number)=>Number.isFinite(x)&&x>=0;
const unknown=(attempts:AttemptAccounting[])=>attempts.some(a=>a.costStatus!=='known');
const spent=(attempts:AttemptAccounting[])=>attempts.reduce((s,a)=>s+(a.costUsd??0),0);
/** Reservations are explicit deployment envelopes, not prices or invoice guarantees.
 * A provider may overrun an envelope: retain the incurred cost and stop immediately.
 * Unknown billing stops retry/escalation. Each physical attempt also uses the model
 * router's provider-specific mandatory guards (including the Azure ledger guard). */
export function createCostAwareRouter(routes:Record<string,Route>,policy:{cheap:string;strong:string;minConfidence:number}) {
  policy={...policy};
  routes=Object.fromEntries(Object.entries(routes).map(([alias,route])=>[alias,{...route,...(route.pricing?{pricing:{...route.pricing}}:{})}]));
  if(!Object.hasOwn(routes,policy.cheap)||!Object.hasOwn(routes,policy.strong)||policy.cheap===policy.strong||!nonnegative(policy.minConfidence)||policy.minConfidence>1)throw new Error('INVALID_ROUTING_POLICY');
  return {async run(request:Omit<ChatRequest,'model'>,options:{signal:AbortSignal;budget:RoutingBudget;verify:(result:ChatChunk,signal:AbortSignal)=>Decision|Promise<Decision>}) {
    const budget=structuredClone(options.budget),records:RoutingRecord[]=[];
    if(!budget||!nonnegative(budget.maxCostUsd)||!Number.isSafeInteger(budget.maxAttempts)||budget.maxAttempts<1||budget.maxAttempts>10||!Number.isSafeInteger(budget.timeoutMs)||budget.timeoutMs<=0||budget.timeoutMs>14_400_000||!budget.reservePerAttemptUsd||!Object.values(budget.reservePerAttemptUsd).every(nonnegative)||!nonnegative(budget.reservePerAttemptUsd.cheap)||!nonnegative(budget.reservePerAttemptUsd.strong)||!Number.isSafeInteger(request.maxTokens)||request.maxTokens!<=0)throw new Error('INVALID_ROUTING_BUDGET');
    const controller=new AbortController();let timedOut=false,attempts=0,denial:Reason='budget';
    const cancel=()=>controller.abort();options.signal.addEventListener('abort',cancel,{once:true});if(options.signal.aborted)cancel();
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},budget.timeoutMs);
    const fail=(reason:Reason):never=>{throw new RoutingFailure(reason,records);};
    const cancelled=()=>{if(controller.signal.aborted)fail(timedOut?'timeout':'aborted');};
    const total=()=>records.reduce((s,r)=>s+r.accounting.costUsd,0);
    const dispatch=async(stage:'cheap'|'strong'):Promise<ChatChunk>=>{
      cancelled();
      const client=createRouter(routes,{beforeAttempt:info=>{
        cancelled();
        if(unknown(info.priorAttempts)){denial='unknown_cost';throw new Error('UNKNOWN_COST');}
        if(info.priorAttempts.some(a=>(a.costUsd??0)>budget.reservePerAttemptUsd[stage])||attempts>=budget.maxAttempts||total()+spent(info.priorAttempts)+budget.reservePerAttemptUsd[stage]>budget.maxCostUsd){denial='budget';throw new Error('BUDGET');}
        attempts++;
      }});
      let result:ChatChunk|undefined;
      try {
        for await(const chunk of client.stream({...structuredClone(request),model:policy[stage]},{signal:controller.signal,run_id:runId,call_id:`${runId}:${stage}`}))result=chunk;
      } catch(error) {
        if(error instanceof ModelError && error.accounting?.attempts.length)records.push({stage,accounting:structuredClone(error.accounting)});
        if(controller.signal.aborted)fail(timedOut?'timeout':'aborted');
        if(error instanceof ModelError&&error.code==='budget_denied')fail(denial);
        fail(records.some(r=>r.accounting.costStatus==='unknown')?'unknown_cost':'model');
      }
      if(!result?.accounting)throw new RoutingFailure('model',records);
      const accounting=result.accounting;
      records.push({stage,accounting:structuredClone(accounting)});
      cancelled();
      if(accounting.costStatus!=='known')fail('unknown_cost');
      if(total()>budget.maxCostUsd||accounting.attempts.some(a=>(a.costUsd??0)>budget.reservePerAttemptUsd[stage]))fail('budget');
      return result;
    };
    const runId=randomUUID();
    try {
      const cheap=await dispatch('cheap');let decision:Decision;
      try {
        // Deadline cancellation must also interrupt an asynchronous verifier.
        decision=await new Promise<Decision>((resolve,reject)=>{
          const abort=()=>reject(new Error('ABORTED'));
          controller.signal.addEventListener('abort',abort,{once:true});
          Promise.resolve().then(()=>options.verify(structuredClone(cheap),controller.signal)).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
          if(controller.signal.aborted)abort();
        });
      } catch {cancelled();throw new RoutingFailure('verifier',records);}
      cancelled();
      if(!decision||typeof decision.pass!=='boolean'||(decision.source==='unavailable'?decision.confidence!==null:decision.source!=='verifier'||decision.confidence===null||!nonnegative(decision.confidence)||decision.confidence>1))fail('verifier');
      const selected=decision.pass&&decision.confidence!==null&&decision.confidence>=policy.minConfidence?'cheap':'strong';
      const result=selected==='cheap'?cheap:await dispatch('strong');
      return {selected,result,decision:decision,records:structuredClone(records),knownCostUsd:total(),costStatus:'known' as const};
    } finally {clearTimeout(timer);options.signal.removeEventListener('abort',cancel);}
  }};
}
