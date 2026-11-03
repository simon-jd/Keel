import {describe,expect,it} from 'vitest';
import {gate,type Report} from '../src/gate.js';
const report=(successes=80,cost=1):Report=>({execution:{implementation:'git-sha',prompt:'prompt-sha',policy:'cheap-first',models:['local']},population:{dataset:'data-sha',protocol:'bfcl-single-turn-v1',scorer:'original-AST',settings:'settings-sha',seed:0},runs:Array.from({length:100},(_,i)=>({runId:`baseline-${i}`,id:`case-${i}`,taskHash:`input-${i}`,status:'completed',success:i<successes,costUsd:cost,costStatus:'known'}))});
describe('regression gate',()=>{
 it('gateFailsOnSuccessDrop',()=>expect(gate(report(),report(77)).reasons).toContain('SUCCESS_DROP_EXCEEDS_2PP'));
 it('gateFailsOnCostIncrease',()=>expect(gate(report(),report(80,1.101)).reasons).toContain('COST_INCREASE_EXCEEDS_10_PERCENT'));
 it('gatePassesWithinThresholds',()=>expect(gate(report(),report(79,1.09))).toEqual({pass:true,reasons:[]}));
 it('passes exact success and decimal cost boundaries',()=>expect(gate(report(80,0.1),report(78,0.11)).pass).toBe(true));
 it('rejects just above the cost boundary and positive cost from zero',()=>{
  expect(gate(report(80,0.1),report(80,0.11000000000000001)).pass).toBe(false);
  expect(gate(report(80,0),report(80,Number.MIN_VALUE)).pass).toBe(false);
  expect(gate(report(80,0),report(80,0)).pass).toBe(true);
 });
 it('pairs by task identity independent of execution and order',()=>{const c=report();c.runs.reverse();c.execution.prompt='changed-description';c.execution.implementation='candidate-git';c.execution.models=['strong'];c.runs.forEach(r=>r.runId='candidate-'+r.id);expect(gate(report(),c).pass).toBe(true);});
 it.each(['missing','duplicate','input','cohort','empty','incomplete','nonfinite','negative','unknown','bad-success','seed'] as const)('fails closed on %s',kind=>{
  const b=report(),c=report();
  if(kind==='missing')c.runs.pop();
  if(kind==='duplicate')c.runs[1]!.id=c.runs[0]!.id;
  if(kind==='input')c.runs[0]!.taskHash='different';
  if(kind==='cohort')c.population.scorer='different';
  if(kind==='empty'){b.runs=[];c.runs=[];}
  if(kind==='incomplete')c.runs[0]!.status='incomplete';
  if(kind==='nonfinite')c.runs[0]!.costUsd=NaN;
  if(kind==='negative')c.runs[0]!.costUsd=-1;
  if(kind==='unknown')c.runs[0]!.costStatus='unknown';
  if(kind==='bad-success'){c.runs[0]!.status='failed';c.runs[0]!.success=true;}
  if(kind==='seed')c.population.seed=NaN;
  expect(gate(b,c).pass).toBe(false);
 });
});
