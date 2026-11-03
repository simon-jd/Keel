/** Disposable weak-reference fixtures; never real human or model evidence. */
import {expect,test} from 'vitest';
import {agentReferenceReport,calibrateAgentReference,validateAgentLabels} from '../src/agentReference.js';
import {validateHumanLabels} from '../src/calibration.js';
const ids=['a','b'],hashes=new Map(ids.map(id=>[id,id.repeat(64)]));
const row=(id:string,label='pass',rater='fixture-agent-one')=>({id,label,rater,origin:'subagent',rubricVersion:'rubric-fixture',cohortHash:'fixture-cohort',annotatedAt:'2026-10-25T08:01:02.123456Z',rationale:'Disposable fixture reasoning',confidence:'medium',inputSha256:hashes.get(id)});
test('agent labels stay source explicit and cannot pass the default human validator',()=>{
 const labels=validateAgentLabels([row('a'),row('b','fail')],ids,'fixture-cohort','rubric-fixture',hashes);expect(labels).toHaveLength(2);
 expect(()=>validateHumanLabels(labels,ids,'fixture-cohort','rubric-fixture')).toThrow();
 expect(()=>validateHumanLabels([{id:'a',label:'pass',origin:'human',rater:'human-fixture',rubricVersion:'rubric-fixture',cohortHash:'fixture-cohort',annotatedAt:'2026-10-25T08:01:02.123456Z'}],ids,'fixture-cohort','rubric-fixture')).toThrow();
 for(const bad of [{...row('a'),origin:'human'},{...row('a'),inputSha256:'wrong'},{...row('a'),confidence:0.9},{...row('a'),rationale:''},{...row('a'),annotatedAt:'2026-02-30T08:01:02.000000Z'}])expect(()=>validateAgentLabels([bad],ids,'fixture-cohort','rubric-fixture',hashes)).toThrow();
 expect(()=>validateAgentLabels([row('a'),row('a')],ids,'fixture-cohort','rubric-fixture',hashes)).toThrow();
});
test('agent agreement/coverage and calibration never claim human gate, accuracy or independent gold truth',()=>{
 const primary=validateAgentLabels([row('a'),row('b','fail')],ids,'fixture-cohort','rubric-fixture',hashes),secondary=validateAgentLabels([row('a','pass','fixture-agent-two')],['a'],'fixture-cohort','rubric-fixture',hashes);
 const report=agentReferenceReport(ids,['a'],primary,secondary);expect(report).toMatchObject({reference_origin:'subagent',human_evidence:false,human_reference_gate_fulfilled:false,accepted_user_substitution:true,agreement:null,agreementReason:'KAPPA_UNDEFINED_PE_ONE'});
 expect(()=>agentReferenceReport(ids,['a'],primary,[{...secondary[0]!,rater:primary[0]!.rater}])).toThrow();
 expect(()=>agentReferenceReport(ids,['a'],primary,[{...secondary[0]!,origin:'human'} as never])).toThrow('SUBAGENT_REFERENCE_REQUIRED');
 expect(agentReferenceReport(ids,['a'],[],secondary).accepted_user_substitution).toBe(false);
 const predictions=primary.map(({id,label})=>({id,label}));const comparison=calibrateAgentReference(ids,primary,{v1:predictions,v2:predictions});
 expect(comparison).toMatchObject({reference_origin:'subagent',human_evidence:false,human_reference_gate_fulfilled:false,selected:'v1',referenceCoverage:{complete:true}});expect(comparison).not.toHaveProperty('humanCoverage');
 expect(calibrateAgentReference(ids,primary,{v1:predictions,v2:[]}).selected).toBeNull();
});
