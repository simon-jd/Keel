import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import type {Report} from '../src/gate.js';
const cli=new URL('../src/gateCli.ts',import.meta.url).pathname;
const tsx=new URL('../../../node_modules/.bin/tsx',import.meta.url).pathname;
const baseline=new URL('../../../data/regression/baseline-report.json',import.meta.url).pathname;
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function run(...args:string[]){return spawnSync(tsx,[cli,...args],{encoding:'utf8'});}
function candidate(edit:(report:Report)=>void):string{
 const report=JSON.parse(readFileSync(baseline,'utf8')) as Report;edit(report);
 const dir=mkdtempSync(join(tmpdir(),'keel-gate-'));dirs.push(dir);
 const path=join(dir,'candidate.json');writeFileSync(path,JSON.stringify(report));return path;
}
it('passes an unchanged candidate',()=>{
 const result=run(baseline,candidate(()=>{}));
 expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual({pass:true,reasons:[]});
});
it('fails a candidate whose success rate drops by more than 2pp',()=>{
 const result=run(baseline,candidate(report=>{report.runs.filter(x=>x.success).slice(0,9).forEach(x=>{x.success=false;});}));
 expect(result.status).toBe(1);expect(JSON.parse(result.stdout).reasons).toContain('SUCCESS_DROP_EXCEEDS_2PP');
});
it('fails with a usage error when the candidate report is missing',()=>{
 const result=run(baseline);
 expect(result.status).toBe(2);expect(result.stderr).toContain('usage');
});
it('workflow compares the committed baseline with the candidate report',()=>{
 const workflow=readFileSync(new URL('../../../.github/workflows/eval-gate.yml',import.meta.url),'utf8');
 expect(workflow).toContain('gateCli.ts data/regression/baseline-qwen3-8b-awq.json data/regression/candidate-report.json');
});
