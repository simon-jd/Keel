export type Domain='airline'|'retail'|'telecom';
export type MatrixCell={model:'local'|'openai'|'anthropic';benchmark:'tau2'|'bfcl';domain?:Domain;seed:number;taskIds:string[];status:'pending'|'prerequisites_missing'};
export function makeMatrix(tasks:Record<Domain,string[]>,bfclIds:string[]):MatrixCell[]{
 const cells:MatrixCell[]=[];
 for(const domain of ['airline','retail','telecom'] as const){
  if(!tasks[domain].length||new Set(tasks[domain]).size!==tasks[domain].length)throw new Error('INVALID_TASKS');
  for(const seed of [0,1,2])cells.push({model:'local',benchmark:'tau2',domain,seed,taskIds:[...tasks[domain]],status:'pending'});
 }
 if(!bfclIds.length)throw new Error('INVALID_TASKS');
 cells.push({model:'local',benchmark:'bfcl',seed:0,taskIds:[...bfclIds],status:'pending'});
 for(const model of ['openai','anthropic'] as const)cells.push({model,benchmark:'tau2',domain:'retail',seed:0,taskIds:tasks.retail.slice(0,1),status:'prerequisites_missing'});
 return cells;
}
export type Observation={status:'completed'|'failed'|'invalid'|'incomplete';success:boolean;latencyMs:number;costUsd:number;costStatus:'known'|'unknown'};
/** Success rate includes failed attempts; pending work never becomes a score. */
export function summarize(rows:Observation[],planned:number){
 if(!Number.isSafeInteger(planned)||planned<rows.length||rows.some(r=>![r.latencyMs,r.costUsd].every(v=>Number.isFinite(v)&&v>=0)))throw new Error('INVALID_RESULTS');
 const scored=rows.filter(r=>r.status==='completed'||r.status==='failed'); const invalid=rows.filter(r=>r.status==='invalid').length;
 const knownCostUsd=rows.reduce((s,r)=>s+r.costUsd,0); const costStatus=rows.some(r=>r.costStatus==='unknown')?'unknown':'known';
 return {...(invalid?{invalid}:{}),planned,finished:rows.length,completed:rows.filter(r=>r.status==='completed').length,failed:rows.filter(r=>r.status==='failed').length,pending:planned-scored.length,successRate:scored.length?scored.filter(r=>r.success).length/scored.length:null,knownCostUsd,costStatus,totalCostUsd:costStatus==='known'?knownCostUsd:null,meanLatencyMs:rows.length?rows.reduce((s,r)=>s+r.latencyMs,0)/rows.length:null};
}
