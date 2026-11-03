import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { withSpan } from 'tracing/span';
import { validateVector } from 'models/rag';
import type { EmbeddingClient } from 'models/rag';
import type { CallAccounting } from 'models/types';
import type { Chunk } from './ingest.js';

export function rrf<T extends { id: string }>(lists: T[][]): (T & { score: number })[] {
  const merged = new Map<string, T & { score: number }>();
  for (const list of lists) {
    const seen = new Set<string>(); let rank = 0;
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id); rank++;
      const previous = merged.get(item.id);
      merged.set(item.id, { ...(previous ?? item), score: (previous?.score ?? 0) + 1 / (60 + rank) });
    }
  }
  return [...merged.values()].sort((a,b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function validateK(k: number) { if (!Number.isSafeInteger(k) || k < 1 || k > 1000) throw new Error('INVALID_K'); }
export type Retrieval = { chunks: Chunk[]; calls: CallAccounting[]; elapsedMs: number; vectorIds: string[]; lexicalIds: string[] };
/** MATERIALIZED scope prevents cosine evaluation against another profile's dimensions. */
export function createRetriever(db: Client, version: string, embeddings: EmbeddingClient, candidateK = 50) {
  validateK(candidateK);
  return async function retrieve(query: string, k: number, signal: AbortSignal = AbortSignal.timeout(120000)): Promise<Retrieval> {
    validateK(k);
    if (k > candidateK || typeof query !== 'string' || !query.trim() || query.length > 32768) throw new Error('INVALID_QUERY');
    return withSpan('retrieval', {}, async () => {
      const started = performance.now(); const profile = embeddings.profile;
      const scope = await db.query('SELECT profile FROM rag_embedding_profiles WHERE id=$1 AND dimension=$2', [profile.id, profile.dimension]);
      if (!scope.rows.length) return { chunks: [], calls: [], elapsedMs: performance.now() - started, vectorIds: [], lexicalIds: [] };
      if (scope.rows[0].profile.model !== profile.model || scope.rows[0].profile.revision !== profile.revision || scope.rows[0].profile.runtimeEvidence !== profile.runtimeEvidence) throw new Error('PROFILE_CONFLICT');
      const count = await db.query('SELECT count(*)::int AS count FROM chunks WHERE version=$1 AND profile_id=$2', [version, profile.id]);
      if (!count.rows[0]?.count) return { chunks: [], calls: [], elapsedMs: performance.now() - started, vectorIds: [], lexicalIds: [] };
      const run_id = randomUUID(); const result = await embeddings.embed([query], { signal, run_id, call_id: `${run_id}:1` });
      if (result.profile.id !== profile.id || result.vectors.length !== 1) throw Object.assign(new Error('PROFILE_CONFLICT'), { calls: [result.accounting] });
      const vector = result.vectors[0]; validateVector(vector, profile.dimension);
      try {
        const vectorRows = await db.query(`WITH scoped AS MATERIALIZED (
          SELECT id,provenance,embedding FROM chunks WHERE version=$1 AND profile_id=$2 AND dimension=$3
        ) SELECT id,provenance FROM scoped ORDER BY embedding <=> $4::vector, id LIMIT $5`, [version,profile.id,profile.dimension,JSON.stringify(vector),candidateK]);
        // Postgres lexical ranking is ts_rank_cd, not mathematical BM25.
        const lexicalRows = await db.query(`SELECT id,provenance FROM chunks
          WHERE version=$1 AND profile_id=$2 AND dimension=$3 AND tsv @@ plainto_tsquery('english',$4)
          ORDER BY ts_rank_cd(tsv,plainto_tsquery('english',$4)) DESC,id LIMIT $5`, [version,profile.id,profile.dimension,query,candidateK]);
        const vectors = vectorRows.rows.map(r => ({ ...(r.provenance as Chunk), id: r.id as string }));
        const lexical = lexicalRows.rows.map(r => ({ ...(r.provenance as Chunk), id: r.id as string }));
        return { chunks: rrf([vectors,lexical]).slice(0,k), calls: [result.accounting], elapsedMs: performance.now()-started, vectorIds: vectors.map(c=>c.id), lexicalIds: lexical.map(c=>c.id) };
      } catch { throw Object.assign(new Error('RETRIEVAL_FAILED'), { calls: [result.accounting] }); }
    });
  };
}
