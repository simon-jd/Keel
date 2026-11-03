import type { Hit } from './bm25.js';

/** Exact (brute-force) cosine search over row-major float32 vectors. Rows are L2-normalized on load. */
export function createDenseIndex(ids: string[], vectors: Float32Array, dimension: number) {
  if (!Number.isSafeInteger(dimension) || dimension < 1 || vectors.length !== ids.length * dimension || !ids.length) throw new Error('INVALID_DENSE_INDEX');
  const matrix = Float32Array.from(vectors);
  for (let row = 0; row < ids.length; row++) normalizeInPlace(matrix, row * dimension, dimension);
  return {
    size: ids.length, dimension,
    search(query: Float32Array, k: number): Hit[] {
      if (query.length !== dimension) throw new Error('INVALID_QUERY_VECTOR');
      const q = Float32Array.from(query); normalizeInPlace(q, 0, dimension);
      const scores = new Float32Array(ids.length);
      for (let row = 0; row < ids.length; row++) {
        let dot = 0; const offset = row * dimension;
        for (let i = 0; i < dimension; i++) dot += matrix[offset + i]! * q[i]!;
        scores[row] = dot;
      }
      return topK(ids, scores, k);
    },
  };
}

function normalizeInPlace(values: Float32Array, offset: number, dimension: number) {
  let norm = 0;
  for (let i = 0; i < dimension; i++) norm += values[offset + i]! ** 2;
  norm = Math.sqrt(norm); if (!(norm > 0)) throw new Error('ZERO_VECTOR');
  for (let i = 0; i < dimension; i++) values[offset + i]! /= norm;
}

export function topK(ids: string[], scores: Float32Array, k: number): Hit[] {
  const order = Array.from(scores.keys()).sort((a, b) => scores[b]! - scores[a]! || (ids[a]! < ids[b]! ? -1 : ids[a]! > ids[b]! ? 1 : 0));
  return order.slice(0, k).map(row => ({ id: ids[row]!, score: scores[row]! }));
}
