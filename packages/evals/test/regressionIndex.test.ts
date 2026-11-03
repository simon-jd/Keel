import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {gate,type Report} from '../src/gate.js';
const read=(name:string)=>readFileSync(new URL(`../../../data/regression/${name}`,import.meta.url));
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
it('binds actual historical indexes, complete population, machine labels and metadata-only exports',()=>{
 const binding=JSON.parse(read('binding.json').toString());
 expect(hash(read('bfcl-validation.jsonl'))).toBe(binding.validationIndexSha256);
 expect(hash(read('bfcl-failures.jsonl'))).toBe(binding.failureIndexSha256);
 const rows=read('bfcl-validation.jsonl').toString().trim().split('\n').map(line=>JSON.parse(line));
 const failures=read('bfcl-failures.jsonl').toString().trim().split('\n').map(line=>JSON.parse(line));
 expect(rows).toHaveLength(400);expect(failures).toHaveLength(176);expect(new Set(rows.map(x=>x.semanticCommitment)).size).toBe(400);
 expect(new Set(rows.map(x=>x.id)).size).toBe(400);expect(failures).toEqual(rows.filter(x=>!x.originalSuccess));
 for(const row of rows){expect(Object.keys(row).sort()).toEqual(['canonicalization','id','labelOrigin','originalSuccess','seed','semanticCommitment','taskHash']);expect(row.labelOrigin).toBe('original-BFCL-AST');}
 expect(binding.human_evidence).toBe(false);
 const proof=JSON.parse(read('baseline-proof.json').toString());
 expect(hash(read('baseline-report.json'))).toBe(proof.reportSha256);expect(hash(read('binding.json'))).toBe(proof.materialBindingSha256);
 const baseline=JSON.parse(read('baseline-report.json').toString()) as Report;
 expect(baseline.runs.map(r=>r.id)).toEqual(rows.map(r=>r.id));expect(baseline.runs.filter(r=>r.success)).toHaveLength(224);
 // Self-comparison validates actual report compatibility; it is not new inference.
 expect(gate(baseline,baseline)).toEqual({pass:true,reasons:[]});
});
it('gates the tool-description drill: corrected-scorer baseline passes itself, the candidate fails on success',()=>{
 const baseline=JSON.parse(read('baseline-qwen3-8b-awq.json').toString()) as Report;
 const candidate=JSON.parse(read('candidate-report.json').toString()) as Report;
 expect(baseline.runs).toHaveLength(400);expect(candidate.runs.map(r=>[r.id,r.taskHash])).toEqual(baseline.runs.map(r=>[r.id,r.taskHash]));
 expect(baseline.population).toEqual(candidate.population);expect(baseline.execution.prompt).not.toBe(candidate.execution.prompt);
 // Real local runs (Qwen3-8B-AWQ, BFCL simple_python): 381/400 with tool descriptions, 323/400 without.
 expect(baseline.runs.filter(r=>r.success)).toHaveLength(381);expect(candidate.runs.filter(r=>r.success)).toHaveLength(323);
 expect(gate(baseline,baseline)).toEqual({pass:true,reasons:[]});
 expect(gate(baseline,candidate)).toEqual({pass:false,reasons:['SUCCESS_DROP_EXCEEDS_2PP']});
});
