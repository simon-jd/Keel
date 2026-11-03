import {test,expect} from 'vitest';
import {makeMatrix,summarize} from '../src/matrix.js';
test('retains all local domains and seeds and conditional commercial rows',()=>{
 const plan=makeMatrix({airline:['a'],retail:['r'],telecom:['t']},['b']);
 expect(plan.filter(x=>x.model==='local'&&x.benchmark==='tau2')).toHaveLength(9);
 expect(plan.filter(x=>x.model==='local'&&x.benchmark==='bfcl')).toHaveLength(1);
 expect(plan.filter(x=>x.model!=='local').every(x=>x.status==='prerequisites_missing')).toBe(true);
});
test('partial and unknown accounting cannot become completed or free results',()=>{
 const result=summarize([{status:'completed',success:true,latencyMs:100,costUsd:0,costStatus:'known'},{status:'failed',success:false,latencyMs:300,costUsd:0.1,costStatus:'unknown'}],3);
 expect(result).toEqual({planned:3,finished:2,completed:1,failed:1,pending:1,successRate:0.5,knownCostUsd:0.1,costStatus:'unknown',totalCostUsd:null,meanLatencyMs:200});
});
test('excludes invalid pre-inference setup from the model score',()=>{
 const summary=summarize([{status:'invalid',success:false,latencyMs:12,costUsd:0,costStatus:'known'}],1);
 expect(summary.successRate).toBeNull();expect(summary.invalid).toBe(1);
});
test('incomplete evidence stays pending and retains incurred cost',()=>{
 const summary=summarize([{status:'incomplete',success:false,latencyMs:12,costUsd:0.2,costStatus:'known'}],1);
 expect(summary.successRate).toBeNull();expect(summary.pending).toBe(1);expect(summary.knownCostUsd).toBe(0.2);
});
