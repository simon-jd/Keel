import {expect,test} from 'vitest';
import {calibrate,validateHumanLabels,coverage} from '../src/calibration.js';
import {RUBRIC} from '../src/judge.js';
const ids=['a','b'];const human=(id:string,label='pass',rater='human-one')=>({id,label,rater,origin:'human',rubricVersion:RUBRIC.version,cohortHash:'cohort',annotatedAt:'2026-10-24T10:00:00Z'});
test('human import checks origin, coverage, rater, rubric, cohort, duplicates and category',()=>{
 expect(coverage(ids,[])).toEqual({expected:2,labeled:0,missing:ids,complete:false});
 expect(validateHumanLabels([human('a'),human('b','fail')],ids,'cohort',RUBRIC.version)).toHaveLength(2);
 for(const rows of [[human('a'),human('a')],[human('unknown')],[{...human('a'),origin:'judge'}],[human('a','unknown')],[{...human('a'),cohortHash:'wrong'}],[{...human('a'),annotatedAt:'bad'}],[human('a'),human('b','fail','other')]]) expect(()=>validateHumanLabels(rows,ids,'cohort',RUBRIC.version)).toThrow();
});
test('missing human labels or uneven prediction coverage cannot select a winner',()=>{
 const versions={v1:[{id:'a',label:'pass'},{id:'b',label:'fail'}],v2:[{id:'a',label:'pass'}]};
 expect(calibrate(ids,[],versions).selected).toBeNull();
 expect(calibrate(ids,[human('a'),human('b','fail')],versions).selected).toBeNull();
});
test('compare same paired humans with declared ties and undefined handling',()=>{
 const labels=[human('a'),human('b','fail')],predictions=[{id:'a',label:'pass'},{id:'b',label:'fail'}];
 const report=calibrate(ids,labels,{v2:predictions,v1:predictions});expect(report.selected).toBe('v1');expect(report.versions.v1?.agreement?.kappa).toBe(1);
 expect(calibrate(['a'],[human('a')],{v1:[{id:'a',label:'pass'}]}).selected).toBeNull();
});
