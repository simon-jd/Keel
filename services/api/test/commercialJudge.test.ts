import {expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {persistCommercialEvent} from '../src/routes/commercialJudge.js';
import {writePrivate,readPrivate} from '../../../packages/evals/src/task9Source.js';
import type {CommercialEvent} from '../../../packages/evals/src/commercialJudge.js';
test('span exporter failure retains the completed charged call and raw evidence before stopping',()=>{
 const directory=mkdtempSync(join(tmpdir(),'keel-commercial-evidence-'));try{
  const pending=join(directory,'pending.json');writePrivate(pending,'{}');
  const events:CommercialEvent[]=[],event={state:'settled',attempt:{physical:1,logical:0,intent:{runId:'synthetic',callId:'synthetic:1',sampleId:'synthetic',requestHash:'a'.repeat(64),preparedAt:'2026-10-25T00:00:00Z'},outcome:'valid',rawResponse:'full synthetic raw response',accounting:{costStatus:'known',costUsd:0.01},usage:{input:2,output:1}}} as CommercialEvent;
  expect(()=>persistCommercialEvent(pending,{schema:1},events,event,true)).toThrow('COMMERCIAL_SPAN_EXPORT_FAILED');
  const stored=JSON.parse(readPrivate(pending));expect(stored).toMatchObject({spanExportFailed:true,status:'settled',events:[{attempt:{rawResponse:'full synthetic raw response',accounting:{costStatus:'known',costUsd:0.01}}}]});expect(events).toHaveLength(1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
