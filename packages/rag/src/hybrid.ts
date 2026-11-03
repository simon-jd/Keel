import { rrf } from './retrieve.js';

/** Hybrid candidates: reciprocal rank fusion (constant 60) of ranked lists, e.g. [dense, bm25]. */
export function hybrid(lists: { id: string }[][], k: number): { id: string; score: number }[] {
  return rrf(lists.map(list => list.map(item => ({ id: item.id })))).slice(0, k);
}
