/** Phase 6 retrieval evaluation: BEIR SciFact / NFCorpus / FiQA-2018 test splits and the
 * 200-question Kubernetes set (sub-agent written), with BM25, dense, hybrid (RRF) and rerank.
 *
 *   bm25       <spec.json> <out>   CPU: BM25 alone (no embeddings)
 *   embed      <spec.json> <out>   GPU: local vLLM pooling server (bge-base-en-v1.5) on :18000
 *   retrieve   <spec.json> <out>   CPU: BM25, dense, hybrid top-100 runs + metrics (needs <out>/emb)
 *   rerank-ce  <spec.json> <out>   GPU: local cross-encoder (bge-reranker-base) over hybrid top-100
 *   rerank-llm <spec.json> <out>   GPU: Qwen3-8B-AWQ relevance prompt over hybrid top-20
 *   summarize  <spec.json> <out>   CPU: metric tables
 * The vLLM key is read from KEEL_VLLM_TOKEN_FILE (scripts/gpu_run.py + local_batch.py set it). */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createCrossEncoder, createEmbeddingClient, embeddingProfile, scoreRelevance } from 'models/rag';
import { createRouter } from 'models/router';
import { analyze, createBm25, BM25_DEFAULTS } from './bm25.js';
import { createDenseIndex } from './dense.js';
import { hybrid } from './hybrid.js';
import { docText, evaluateRun, loadCorpus, loadQueries, parseQrels, ndcgAt, recallAt, type Qrels } from './beir.js';
import { recallAtK } from './eval.js';

type Spec = {
  embedding: { model: string; revision: string; dimension: number; queryInstruction: string; truncateTokens: number };
  crossEncoder: { model: string; revision: string; truncateTokens: number };
  llm: { model: string; revision: string; candidates: number; documentChars: number };
  datasets: { name: string; corpus: string; queries: string; qrels: string }[];
  kubernetes: { chunks: string; qa: string };
};
type Doc = { id: string; text: string };
type Item = { name: string; docs: Doc[]; queries: { id: string; text: string }[]; qrels?: Qrels; gold?: Map<string, string[]> };

const writeJson = (path: string, value: unknown) => writeFileSync(path, gzipSync(JSON.stringify(value), { level: 9 }));
const readJson = <T>(path: string): T => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as T;
const token = () => readFileSync(process.env.KEEL_VLLM_TOKEN_FILE ?? '.secrets/vllm-token', 'utf8').trim();
const percentile = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null; };

function items(spec: Spec): Item[] {
  const result: Item[] = spec.datasets.map(d => {
    const qrels = parseQrels(readFileSync(d.qrels, 'utf8'));
    const all = loadQueries(d.queries);
    // Only test-split queries (those with qrels) are evaluated and embedded.
    const queries = [...qrels.keys()].filter(id => all.has(id)).sort().map(id => ({ id, text: all.get(id)! }));
    return { name: d.name, docs: loadCorpus(d.corpus).map(doc => ({ id: doc.id, text: docText(doc) })), queries, qrels };
  });
  const chunks = readFileSync(spec.kubernetes.chunks, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { id: string; text: string });
  const qa = readFileSync(spec.kubernetes.qa, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { id: string; question: string; goldChunkIds: string[] });
  result.push({ name: 'kubernetes', docs: chunks.map(c => ({ id: c.id, text: c.text })), queries: qa.map(q => ({ id: q.id, text: q.question })), gold: new Map(qa.map(q => [q.id, q.goldChunkIds])) });
  return result;
}

async function pool<T>(inputs: T[], width: number, work: (input: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < inputs.length) { const i = next++; await work(inputs[i]!, i); } }));
}

async function embed(spec: Spec, out: string) {
  const e = spec.embedding;
  const profile = embeddingProfile({ alias: 'local-embed', provider: 'openaiCompatible', model: 'keel-embed', revision: `${e.model}@${e.revision}`, dimension: e.dimension, runtimeEvidence: 'vllm-0.17.1-pooling-local-files-sha256-verified' });
  const client = createEmbeddingClient({ profile, endpoint: 'http://127.0.0.1:18000/v1', apiKey: token(), truncatePromptTokens: e.truncateTokens });
  mkdirSync(join(out, 'emb'), { recursive: true });
  const stats: Record<string, unknown> = {};
  for (const item of items(spec)) {
    for (const [kind, texts, ids] of [['corpus', item.docs.map(d => d.text), item.docs.map(d => d.id)], ['queries', item.queries.map(q => e.queryInstruction + q.text), item.queries.map(q => q.id)]] as const) {
      const started = performance.now(); const vectors = new Float32Array(texts.length * e.dimension); let tokens = 0; let calls = 0;
      const batches = Array.from({ length: Math.ceil(texts.length / 32) }, (_, i) => i);
      const latencies: number[] = [];
      await pool(batches, 8, async batch => {
        // Whitespace-only documents cannot be embedded; a single space marker keeps their row.
        const slice = texts.slice(batch * 32, batch * 32 + 32).map(t => t.trim() ? t.slice(0, 20000) : '[empty]');
        const run_id = randomUUID(); const t0 = performance.now();
        const result = await client.embed(slice, { signal: AbortSignal.timeout(120000), run_id, call_id: `${run_id}:1` });
        latencies.push(performance.now() - t0); calls++; tokens += result.accounting.usage?.input ?? 0;
        result.vectors.forEach((v, i) => vectors.set(v, (batch * 32 + i) * e.dimension));
      });
      writeFileSync(join(out, 'emb', `${item.name}.${kind}.f32`), Buffer.from(vectors.buffer));
      writeFileSync(join(out, 'emb', `${item.name}.${kind}.ids.json`), JSON.stringify(ids));
      stats[`${item.name}.${kind}`] = { texts: texts.length, calls, inputTokens: tokens, seconds: (performance.now() - started) / 1000, callLatencyMsP50: percentile(latencies, 0.5), callLatencyMsP95: percentile(latencies, 0.95),
        sha256: createHash('sha256').update(Buffer.from(vectors.buffer)).digest('hex') };
      process.stdout.write(JSON.stringify({ event: 'embedded', key: `${item.name}.${kind}`, ...stats[`${item.name}.${kind}`] as object }) + '\n');
    }
  }
  writeFileSync(join(out, 'emb', 'stats.json'), JSON.stringify(stats, null, 1));
}

const loadVectors = (out: string, name: string, kind: string) => new Float32Array(readFileSync(join(out, 'emb', `${name}.${kind}.f32`)).buffer.slice(0));
const loadIds = (out: string, name: string, kind: string) => JSON.parse(readFileSync(join(out, 'emb', `${name}.${kind}.ids.json`), 'utf8')) as string[];

/** Runs: method -> query id -> ranked doc ids (top 100). */
type Runs = Record<string, Record<string, string[]>>;

/** BM25 alone (no embeddings needed): the lexical row and the check against published BM25. */
function bm25Only(spec: Spec, out: string) {
  const result: Record<string, unknown> = {};
  for (const item of items(spec)) {
    const t0 = performance.now(); const index = createBm25(item.docs, BM25_DEFAULTS);
    const run = new Map(item.queries.map(q => [q.id, index.search(q.text, 100).map(h => h.id)]));
    // Diagnostic for the earlier Postgres lexical side: plainto_tsquery ANDs every query term, so a
    // question only matches chunks containing all of its (stemmed, non-stop) terms.
    const docTerms = item.gold ? item.docs.map(d => new Set(analyze(d.text))) : [];
    const andMatched = item.gold ? item.queries.filter(q => { const terms = [...new Set(analyze(q.text))]; return docTerms.some(set => terms.every(t => set.has(t))); }).length : undefined;
    result[item.name] = item.qrels ? { ...evaluateRun(run, item.qrels), ms: performance.now() - t0 }
      : { recall10: item.queries.reduce((a, q) => a + recallAtK(item.gold!.get(q.id)!, run.get(q.id)!, 10), 0) / item.queries.length,
          hitsAt10: item.queries.filter(q => recallAtK(item.gold!.get(q.id)!, run.get(q.id)!, 10) > 0).length, queriesWithAnAllTermsChunk: andMatched, ms: performance.now() - t0 };
    process.stdout.write(JSON.stringify({ event: 'bm25', name: item.name, ...result[item.name] as object }) + '\n');
  }
  writeFileSync(join(out, 'bm25-only.json'), JSON.stringify({ params: BM25_DEFAULTS, result }, null, 1));
}

function retrieve(spec: Spec, out: string) {
  mkdirSync(join(out, 'runs'), { recursive: true });
  const timing: Record<string, unknown> = {};
  for (const item of items(spec)) {
    const t0 = performance.now(); const bm25 = createBm25(item.docs, BM25_DEFAULTS); const indexMs = performance.now() - t0;
    const ids = loadIds(out, item.name, 'corpus'); if (ids.join('\n') !== item.docs.map(d => d.id).join('\n')) throw new Error('EMBEDDING_ID_DRIFT');
    const dense = createDenseIndex(ids, loadVectors(out, item.name, 'corpus'), spec.embedding.dimension);
    const queryVectors = loadVectors(out, item.name, 'queries'); const queryIds = loadIds(out, item.name, 'queries');
    const runs: Runs = { bm25: {}, dense: {}, hybrid: {} }; const ms = { bm25: [] as number[], dense: [] as number[] };
    item.queries.forEach((q, i) => {
      if (queryIds[i] !== q.id) throw new Error('QUERY_ID_DRIFT');
      let s = performance.now(); const lexical = bm25.search(q.text, 100); ms.bm25.push(performance.now() - s);
      s = performance.now(); const vector = dense.search(queryVectors.subarray(i * spec.embedding.dimension, (i + 1) * spec.embedding.dimension), 100); ms.dense.push(performance.now() - s);
      runs.bm25![q.id] = lexical.map(h => h.id); runs.dense![q.id] = vector.map(h => h.id);
      runs.hybrid![q.id] = hybrid([vector, lexical], 100).map(h => h.id);
    });
    writeJson(join(out, 'runs', `${item.name}.json.gz`), runs);
    timing[item.name] = { docs: item.docs.length, queries: item.queries.length, bm25IndexMs: indexMs, bm25QueryMsP50: percentile(ms.bm25, 0.5), denseQueryMsP50: percentile(ms.dense, 0.5) };
    process.stdout.write(JSON.stringify({ event: 'retrieved', name: item.name, ...timing[item.name] as object }) + '\n');
  }
  writeFileSync(join(out, 'runs', 'timing.json'), JSON.stringify(timing, null, 1));
}

async function rerankCe(spec: Spec, out: string) {
  const ce = createCrossEncoder({ model: 'keel-rerank', endpoint: 'http://127.0.0.1:18000/v1', apiKey: token(), truncatePromptTokens: spec.crossEncoder.truncateTokens });
  for (const item of items(spec)) {
    const runs = readJson<Runs>(join(out, 'runs', `${item.name}.json.gz`)); const docs = new Map(item.docs.map(d => [d.id, d.text]));
    const reranked: Record<string, string[]> = {}; const latencies: number[] = []; let tokens = 0; const started = performance.now();
    await pool(item.queries, 8, async q => {
      const candidates = runs.hybrid![q.id]!; const run_id = randomUUID(); const t0 = performance.now();
      const result = await ce.rerank(q.text, candidates.map(id => docs.get(id)!.slice(0, 20000) || '[empty]'), { signal: AbortSignal.timeout(300000), run_id, call_id: `${run_id}:1` });
      latencies.push(performance.now() - t0); tokens += result.accounting.usage?.input ?? 0;
      reranked[q.id] = candidates.map((id, i) => ({ id, score: result.scores[i]!, i })).sort((a, b) => b.score - a.score || a.i - b.i).map(x => x.id);
    });
    runs['hybrid+ce'] = reranked;
    writeJson(join(out, 'runs', `${item.name}.json.gz`), runs);
    const stats = { queries: item.queries.length, pairs: item.queries.length * 100, seconds: (performance.now() - started) / 1000, inputTokens: tokens, callMsP50: percentile(latencies, 0.5), callMsP95: percentile(latencies, 0.95) };
    writeFileSync(join(out, 'runs', `${item.name}.ce-stats.json`), JSON.stringify(stats, null, 1));
    process.stdout.write(JSON.stringify({ event: 'ce', name: item.name, ...stats }) + '\n');
  }
}

async function rerankLlm(spec: Spec, out: string) {
  const router = createRouter({ local: { provider: 'openaiCompatible', endpoint: 'http://127.0.0.1:18000/v1', model: 'keel-local', apiKey: token(), pricing: { inputPerMillion: 0, outputPerMillion: 0 } } });
  const k = spec.llm.candidates;
  for (const item of items(spec)) {
    const runs = readJson<Runs>(join(out, 'runs', `${item.name}.json.gz`)); const docs = new Map(item.docs.map(d => [d.id, d.text]));
    const pairs = item.queries.flatMap(q => runs.hybrid![q.id]!.slice(0, k).map((id, rank) => ({ q, id, rank })));
    const scores = new Map<string, number>(); let failures = 0; let input = 0; let output = 0; const latencies: number[] = []; const started = performance.now();
    await pool(pairs, 16, async pair => {
      const run_id = randomUUID(); const t0 = performance.now();
      try {
        const result = await scoreRelevance(router, 'local', pair.q.text, docs.get(pair.id)!.slice(0, spec.llm.documentChars), { signal: AbortSignal.timeout(120000), run_id, call_id: `${run_id}:1` });
        scores.set(`${pair.q.id}\t${pair.id}`, result.score); input += result.accounting.usage?.input ?? 0; output += result.accounting.usage?.output ?? 0;
      } catch (error) {
        // A malformed score ranks the candidate last; failures are counted and reported.
        failures++; const a = (error as { accounting?: { usage?: { input: number; output: number } } }).accounting; input += a?.usage?.input ?? 0; output += a?.usage?.output ?? 0;
      }
      latencies.push(performance.now() - t0);
    });
    runs['hybrid+llm'] = Object.fromEntries(item.queries.map(q => [q.id, runs.hybrid![q.id]!.slice(0, k)
      .map((id, i) => ({ id, i, score: scores.get(`${q.id}\t${id}`) ?? -1 })).sort((a, b) => b.score - a.score || a.i - b.i).map(x => x.id)]));
    writeJson(join(out, 'runs', `${item.name}.json.gz`), runs);
    const stats = { queries: item.queries.length, candidates: k, calls: pairs.length, failures, inputTokens: input, outputTokens: output, seconds: (performance.now() - started) / 1000, callMsP50: percentile(latencies, 0.5), callMsP95: percentile(latencies, 0.95) };
    writeFileSync(join(out, 'runs', `${item.name}.llm-stats.json`), JSON.stringify(stats, null, 1));
    process.stdout.write(JSON.stringify({ event: 'llm', name: item.name, ...stats }) + '\n');
  }
}

function summarize(spec: Spec, out: string) {
  const table: Record<string, Record<string, unknown>> = {}; const perQuery: Record<string, unknown> = {};
  for (const item of items(spec)) {
    const runs = readJson<Runs>(join(out, 'runs', `${item.name}.json.gz`)); table[item.name] = {};
    const rows: Record<string, unknown>[] = [];
    for (const [method, run] of Object.entries(runs)) {
      if (item.qrels) {
        const m = evaluateRun(new Map(Object.entries(run)), item.qrels);
        // Top-20 depth variants are compared only within that depth (see the report).
        table[item.name]![method] = m;
        // Same-depth control for the LLM rerank: cross-encoder order of the same hybrid top-20.
        if (method === 'hybrid+ce' && runs['hybrid+llm']) {
          const top = Object.fromEntries(Object.entries(run).map(([q, ids]) => [q, ids.filter(id => runs.hybrid![q]!.slice(0, spec.llm.candidates).includes(id))]));
          table[item.name]!['hybrid@20+ce'] = evaluateRun(new Map(Object.entries(top)), item.qrels);
          table[item.name]!['hybrid@20'] = evaluateRun(new Map(Object.entries(runs.hybrid!).map(([q, ids]) => [q, ids.slice(0, spec.llm.candidates)])), item.qrels);
        }
      } else {
        const recall = item.queries.map(q => recallAtK(item.gold!.get(q.id)!, run[q.id] ?? [], 10));
        table[item.name]![method] = { queries: recall.length, recall10: recall.reduce((a, b) => a + b, 0) / recall.length, hitsAt10: recall.filter(r => r > 0).length };
        if (method === 'hybrid+ce' && runs['hybrid+llm']) {
          const at20 = item.queries.map(q => recallAtK(item.gold!.get(q.id)!, (run[q.id] ?? []).filter(id => runs.hybrid![q.id]!.slice(0, spec.llm.candidates).includes(id)), 10));
          table[item.name]!['hybrid@20+ce'] = { queries: at20.length, recall10: at20.reduce((a, b) => a + b, 0) / at20.length, hitsAt10: at20.filter(r => r > 0).length };
        }
      }
    }
    for (const q of item.queries) rows.push({ q: q.id, ...Object.fromEntries(Object.entries(runs).map(([method, run]) => [method, item.qrels
      ? { ndcg10: ndcgAt((run[q.id] ?? []).filter(d => d !== q.id), item.qrels.get(q.id)!, 10), recall100: recallAt(run[q.id] ?? [], item.qrels.get(q.id)!, 100), top10: (run[q.id] ?? []).slice(0, 10) }
      : { recall10: recallAtK(item.gold!.get(q.id)!, run[q.id] ?? [], 10), top10: (run[q.id] ?? []).slice(0, 10) }])) });
    perQuery[item.name] = rows;
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ bm25: BM25_DEFAULTS, rrfK: 60, table }, null, 1));
  writeJson(join(out, 'per-query.json.gz'), perQuery);
  process.stdout.write(JSON.stringify(table, null, 1) + '\n');
}

const [command, specPath, out] = process.argv.slice(2);
if (!command || !specPath || !out) throw new Error('usage: beirRun.ts bm25|embed|retrieve|rerank-ce|rerank-llm|summarize <spec.json> <out>');
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const commands: Record<string, () => unknown> = { bm25: () => bm25Only(spec, out), embed: () => embed(spec, out), retrieve: () => retrieve(spec, out), 'rerank-ce': () => rerankCe(spec, out), 'rerank-llm': () => rerankLlm(spec, out), summarize: () => summarize(spec, out) };
if (!commands[command]) throw new Error('UNKNOWN_COMMAND');
await commands[command]!();
