import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createRouter } from 'models/router';
import { configureTracing } from 'tracing/exporter';
import { createAgentApp } from './routes/agent.js';
import { createSpanSpool } from './spool.js';
import {createLocalJudgeRoute,localJudgeIdentityFromEnvironment} from 'models/localJudgeProfile';
// Local-only executable. No commercial endpoint, model, key or price supplied by HTTP callers.
const localJudgeProfile=localJudgeIdentityFromEnvironment(process.env);
const token=readFileSync(process.env.KEEL_TOKEN_FILE??'.secrets/benchmark-token','utf8').trim();
const vllmToken=readFileSync(process.env.KEEL_VLLM_TOKEN_FILE??'.secrets/vllm-token','utf8').trim();
const tracing=configureTracing({exporter:createSpanSpool(process.env.KEEL_SPAN_FILE??'.tools/benchmark-spans.jsonl')});
const model=createRouter({local:localJudgeProfile?createLocalJudgeRoute(localJudgeProfile,vllmToken):{provider:'openaiCompatible',endpoint:'http://127.0.0.1:18000/v1',model:'keel-local',apiKey:vllmToken,pricing:{inputPerMillion:0,outputPerMillion:0}}});
const app=createAgentApp({model,token,benchmarkUnknownTools:!localJudgeProfile,maxRequests:Number(process.env.KEEL_MAX_REQUESTS??1000),maxConcurrent:Number(process.env.KEEL_MAX_CONCURRENT??1)});
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:18080});
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;server.close();await tracing.shutdown();};
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
