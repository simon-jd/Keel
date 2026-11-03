import { expect, test } from 'vitest';
import { analyze, porterStem, createBm25, BM25_DEFAULTS } from '../src/bm25.js';
import { createDenseIndex } from '../src/dense.js';
import { hybrid } from '../src/hybrid.js';
import { ndcgAt, recallAt, parseQrels, evaluateRun } from '../src/beir.js';

test('porter stemmer matches the reference vocabulary', () => {
  // Pairs from Martin Porter's published voc.txt / output.txt.
  const pairs: [string, string][] = [['caresses', 'caress'], ['ponies', 'poni'], ['ties', 'ti'], ['caress', 'caress'], ['cats', 'cat'],
    ['feed', 'feed'], ['agreed', 'agre'], ['plastered', 'plaster'], ['bled', 'bled'], ['motoring', 'motor'], ['sing', 'sing'],
    ['conflated', 'conflat'], ['troubled', 'troubl'], ['sized', 'size'], ['hopping', 'hop'], ['tanned', 'tan'], ['falling', 'fall'],
    ['hissing', 'hiss'], ['fizzed', 'fizz'], ['failing', 'fail'], ['filing', 'file'], ['happy', 'happi'], ['sky', 'sky'],
    ['relational', 'relat'], ['conditional', 'condit'], ['rational', 'ration'], ['valenci', 'valenc'], ['digitizer', 'digit'],
    ['conformabli', 'conform'], ['radicalli', 'radic'], ['differentli', 'differ'], ['vileli', 'vile'], ['analogousli', 'analog'],
    ['vietnamization', 'vietnam'], ['predication', 'predic'], ['operator', 'oper'], ['feudalism', 'feudal'], ['decisiveness', 'decis'],
    ['hopefulness', 'hope'], ['callousness', 'callous'], ['formaliti', 'formal'], ['sensitiviti', 'sensit'], ['sensibiliti', 'sensibl'],
    ['triplicate', 'triplic'], ['formative', 'form'], ['formalize', 'formal'], ['electriciti', 'electr'], ['electrical', 'electr'],
    ['hopeful', 'hope'], ['goodness', 'good'], ['revival', 'reviv'], ['allowance', 'allow'], ['inference', 'infer'], ['airliner', 'airlin'],
    ['gyroscopic', 'gyroscop'], ['adjustable', 'adjust'], ['defensible', 'defens'], ['irritant', 'irrit'], ['replacement', 'replac'],
    ['adjustment', 'adjust'], ['dependent', 'depend'], ['adoption', 'adopt'], ['homologou', 'homolog'], ['communism', 'commun'],
    ['activate', 'activ'], ['angulariti', 'angular'], ['homologous', 'homolog'], ['effective', 'effect'], ['bowdlerize', 'bowdler'],
    ['probate', 'probat'], ['rate', 'rate'], ['cease', 'ceas'], ['controll', 'control'], ['roll', 'roll'], ['generalizations', 'gener'],
    ['oscillators', 'oscil'], ['is', 'is'], ['as', 'as']];
  for (const [word, stem] of pairs) expect([word, porterStem(word)]).toEqual([word, stem]);
});

test('analyzer: lowercase, possessive, Lucene English stop set, Porter', () => {
  expect(analyze("The Kubelet's pods are RUNNING in the U.S.A, aren't they? node_pool-2")).toEqual(
    ['kubelet', 'pod', 'run', 'u.s.a', "aren't", 'node_pool', '2']);
});

test('okapi BM25 uses Lucene idf and length normalization with k1 and b', () => {
  const docs = [{ id: 'a', text: 'pod pod scheduling' }, { id: 'b', text: 'pod network policy' }, { id: 'c', text: 'volume storage class' }];
  expect(BM25_DEFAULTS).toEqual({ k1: 0.9, b: 0.4 });
  const index = createBm25(docs);
  const hits = index.search('pod scheduling', 3);
  expect(hits.map(h => h.id)).toEqual(['a', 'b']);
  const idf = (df: number) => Math.log(1 + (3 - df + 0.5) / (df + 0.5));
  const avg = 3; const norm = (len: number) => 0.9 * (1 - 0.4 + 0.4 * len / avg);
  expect(hits[0]!.score).toBeCloseTo(idf(2) * 2 / (2 + norm(3)) + idf(1) * 1 / (1 + norm(3)), 10);
  expect(hits[1]!.score).toBeCloseTo(idf(2) * 1 / (1 + norm(3)), 10);
  expect(index.search('nothing matches', 3)).toEqual([]);
});

test('dense index ranks by cosine and hybrid merges with RRF', () => {
  const dense = createDenseIndex(['x', 'y', 'z'], new Float32Array([1, 0, 0, 1, 0.6, 0.8]), 2);
  expect(dense.search(new Float32Array([0, 2]), 2).map(h => h.id)).toEqual(['y', 'z']);
  const merged = hybrid([[{ id: 'y' }, { id: 'z' }], [{ id: 'z' }, { id: 'x' }]], 3);
  expect(merged.map(h => h.id)).toEqual(['z', 'y', 'x']);
});

test('BEIR metrics: graded nDCG@10 (linear gain) and Recall@100 as in pytrec_eval', () => {
  const qrels = parseQrels('query-id\tcorpus-id\tscore\nq1\td1\t2\nq1\td2\t1\nq1\td9\t0\nq2\td3\t1\n');
  expect(qrels.get('q1')).toEqual(new Map([['d1', 2], ['d2', 1], ['d9', 0]]));
  const dcg = 1 / Math.log2(2) + 2 / Math.log2(3); const ideal = 2 / Math.log2(2) + 1 / Math.log2(3);
  expect(ndcgAt(['d2', 'd1', 'd5'], qrels.get('q1')!, 10)).toBeCloseTo(dcg / ideal, 12);
  expect(recallAt(['d5', 'd2'], qrels.get('q1')!, 100)).toBeCloseTo(0.5, 12);
  const summary = evaluateRun(new Map([['q1', ['d1', 'd2']], ['q2', []]]), qrels);
  expect(summary.queries).toBe(2);
  expect(summary.ndcg10).toBeCloseTo(0.5, 12);
  expect(summary.recall100).toBeCloseTo(0.5, 12);
});
