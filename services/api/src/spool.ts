import { closeSync, fsyncSync, fstatSync, openSync, writeSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { configureTracing } from 'tracing/exporter';
type Exporter=NonNullable<NonNullable<Parameters<typeof configureTracing>[0]>['exporter']>;
/** A bounded local sink for actual privacy-projected OTel spans, not synthesized metrics. */
export function createSpanSpool(path:string,maxBytes=32_000_000,durable=false):Exporter {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>100_000_000)throw new Error('INVALID_SPOOL_LIMIT');
  const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600); let bytes=0;let closed=false;
  try {
    if(!fstatSync(fd).isFile())throw new Error('INVALID_SPOOL');
    if(durable){
      fsyncSync(fd);
      const parent=openSync(dirname(resolve(path)),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{fsyncSync(parent);}finally{closeSync(parent);}
    }
  }catch(error){closeSync(fd);throw error;}
  return {export(spans,callback){
    try{
      const text=spans.map(s=>JSON.stringify({format:'keel-otel-span-v1',...s.spanContext(),parentSpanContext:s.parentSpanContext,name:s.name,kind:s.kind,startTime:s.startTime,endTime:s.endTime,duration:s.duration,status:s.status,attributes:s.attributes,resource:s.resource.attributes,instrumentationScope:s.instrumentationScope})+'\n').join('');
      const buffer=Buffer.from(text);if(closed||bytes+buffer.length>maxBytes)throw new Error('SPOOL_LIMIT');
      let offset=0;while(offset<buffer.length)offset+=writeSync(fd,buffer,offset,buffer.length-offset);bytes+=buffer.length;if(durable)fsyncSync(fd);callback({code:0});
    }catch{callback({code:1});}
  },async shutdown(){if(!closed){closed=true;try{if(durable)fsyncSync(fd);}finally{closeSync(fd);}}},async forceFlush(){if(durable&&!closed)fsyncSync(fd);}};
}
