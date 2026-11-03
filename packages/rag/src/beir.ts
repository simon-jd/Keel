import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** BEIR test-split loading and the standard BEIR metrics (pytrec_eval definitions). */
export type BeirDoc = { id: string; title: string; text: string };
export type Qrels = Map<string, Map<string, number>>;

export function readJsonlGz<T>(path: string): T[] {
  return gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as T);
}
export function loadCorpus(path: string): BeirDoc[] {
  return readJsonlGz<{ _id: string; title?: string; text?: string }>(path).map(d => ({ id: String(d._id), title: d.title ?? '', text: d.text ?? '' }));
}
export function loadQueries(path: string): Map<string, string> {
  return new Map(readJsonlGz<{ _id: string; text: string }>(path).map(q => [String(q._id), q.text]));
}
export function parseQrels(tsv: string): Qrels {
  const qrels: Qrels = new Map();
  for (const [index, line] of tsv.split('\n').entries()) {
    if (!line.trim() || (index === 0 && line.startsWith('query-id'))) continue;
    const [query, doc, score] = line.split('\t');
    if (!query || !doc || score === undefined || !Number.isFinite(Number(score))) throw new Error('INVALID_QRELS');
    let row = qrels.get(query); if (!row) qrels.set(query, row = new Map());
    row.set(doc, Number(score));
  }
  return qrels;
}
/** Documents are indexed as title + " " + text, as in the BEIR and Pyserini "flat" baselines. */
export const docText = (doc: BeirDoc) => (doc.title ? doc.title + ' ' : '') + doc.text;

/** nDCG@k, trec_eval/pytrec_eval `ndcg_cut`: gain = graded relevance, discount log2(rank + 1),
 * ideal ranking from all judged documents of the query. */
export function ndcgAt(ranked: string[], judged: Map<string, number>, k: number): number {
  let dcg = 0;
  ranked.slice(0, k).forEach((doc, i) => { const rel = judged.get(doc) ?? 0; if (rel > 0) dcg += rel / Math.log2(i + 2); });
  const ideal = [...judged.values()].filter(r => r > 0).sort((a, b) => b - a).slice(0, k).reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
  return ideal > 0 ? dcg / ideal : 0;
}
/** Recall@k: relevant (score > 0) documents retrieved in the top k over all relevant documents. */
export function recallAt(ranked: string[], judged: Map<string, number>, k: number): number {
  const relevant = [...judged].filter(([, rel]) => rel > 0).map(([doc]) => doc);
  if (!relevant.length) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter(doc => top.has(doc)).length / relevant.length;
}
/** Mean over every query that has qrels (BEIR evaluates the qrels' query set). A retrieved
 * document whose id equals the query id is dropped, as BEIR's evaluator does. */
export function evaluateRun(run: Map<string, string[]>, qrels: Qrels) {
  let ndcg = 0; let recall = 0; let queries = 0;
  for (const [query, judged] of qrels) {
    if (![...judged.values()].some(r => r > 0)) continue;
    const ranked = (run.get(query) ?? []).filter(doc => doc !== query);
    ndcg += ndcgAt(ranked, judged, 10); recall += recallAt(ranked, judged, 100); queries++;
  }
  return { queries, ndcg10: queries ? ndcg / queries : 0, recall100: queries ? recall / queries : 0 };
}
