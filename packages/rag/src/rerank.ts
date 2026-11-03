import { randomUUID } from 'node:crypto';
import { RELEVANCE_PROMPT, scoreRelevance, SCORING_PROTOCOL, SCORING_PROTOCOL_HASH } from 'models/rag';
import type { CallAccounting, ModelClient } from 'models/types';
import { sha256 } from './ingest.js';
import type { Chunk } from './ingest.js';
import { validateK } from './retrieve.js';
export const RERANK_PROMPT_HASH = sha256(RELEVANCE_PROMPT);
export type ScorerBinding = { alias: string; model: string; revision: string; runtimeEvidence: string };
/** One model-API relevance call per candidate. All calls, failures and original candidates are retained. */
export function createReranker(client: ModelClient, binding: ScorerBinding) {
  if (Object.values(binding).some(v => typeof v !== 'string' || !v.trim())) throw new Error('RERANK_CONFIG_REQUIRED');
  binding = Object.freeze({ ...binding });
  const admittedClient: ModelClient = { stream: client.stream.bind(client) };
  return async function rerank(query: string, candidates: Chunk[], k: number, signal: AbortSignal = AbortSignal.timeout(120000)) {
    validateK(k);
    candidates = structuredClone(candidates);
    if (new Set(candidates.map(c=>c.id)).size !== candidates.length || candidates.some(c=>c.version !== candidates[0]?.version)) throw new Error('INVALID_CANDIDATES');
    const calls: CallAccounting[] = []; const failures: {id:string;code:string}[] = []; const scores: {chunk:Chunk;score:number;rank:number}[] = [];
    const started=performance.now(); const run_id=randomUUID();
    for (const [rank,chunk] of candidates.entries()) {
      try {
        const result=await scoreRelevance(admittedClient,binding.alias,query,chunk.text,{signal,run_id,call_id:`${run_id}:${rank+1}`});calls.push(result.accounting);
        if(result.accounting.model!==binding.model)throw new Error('RERANK_MODEL_MISMATCH');
        scores.push({chunk,score:result.score,rank});
      } catch(error) {
        const accounting=(error as {accounting?:CallAccounting}).accounting;if(accounting)calls.push(accounting);
        failures.push({id:chunk.id,code:'MODEL_SCORE_FAILED'});
      }
    }
    // A failed scoring pass must never silently become a shortened, apparently successful retrieval.
    if(failures.length)throw Object.assign(new Error('RERANK_FAILED'),{calls,failures,candidateIds:candidates.map(c=>c.id),binding,protocol:SCORING_PROTOCOL,protocolHash:SCORING_PROTOCOL_HASH,promptHash:RERANK_PROMPT_HASH});
    scores.sort((a,b)=>b.score-a.score||a.rank-b.rank);
    return {chunks:scores.slice(0,k).map(x=>x.chunk),scores:scores.map(x=>({id:x.chunk.id,score:x.score})),calls,elapsedMs:performance.now()-started,binding,protocol:SCORING_PROTOCOL,protocolHash:SCORING_PROTOCOL_HASH,promptHash:RERANK_PROMPT_HASH,candidateIds:candidates.map(c=>c.id)};
  };
}

/** Compose hybrid candidate retrieval and mandatory model reranking; inspect retains the paired candidates. */
export function createRagPipeline(retrieveCandidates:(query:string,k:number,signal?:AbortSignal)=>Promise<import('./retrieve.js').Retrieval>,rerank:ReturnType<typeof createReranker>,candidateK:number) {
  validateK(candidateK);
  async function inspect(query:string,k:number,signal:AbortSignal=AbortSignal.timeout(120000)) {
    validateK(k);if(k>candidateK)throw new Error('INVALID_K');
    const before=await retrieveCandidates(query,candidateK,signal);
    try {
      const after=await rerank(query,before.chunks,k,signal);
      return {before:before.chunks,after:after.chunks,calls:[...before.calls,...after.calls],elapsedMs:before.elapsedMs+after.elapsedMs,vectorIds:before.vectorIds,lexicalIds:before.lexicalIds,rerank:after};
    }catch(error){throw Object.assign(new Error('RAG_PIPELINE_FAILED'),{calls:[...before.calls,...((error as {calls?:CallAccounting[]}).calls??[])],beforeIds:before.chunks.map(c=>c.id)});}
  }
  return {inspect,async retrieve(query:string,k:number):Promise<Chunk[]>{return (await inspect(query,k)).after;}};
}
