import { createHash } from 'node:crypto';
/** Strict JSON only: neither JSON.stringify's lossy coercions nor delimiter collisions are identities. */
export function canonical(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || ancestors.has(item)) throw new Error('INVALID_JSON');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${Array.from(item, encode).join(',')}]`;
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('INVALID_JSON');
      if (Reflect.ownKeys(item).some(k => typeof k !== 'string')) throw new Error('INVALID_JSON');
      return `{${Object.keys(item).sort().map(k => `${JSON.stringify(k)}:${encode((item as Record<string, unknown>)[k])}`).join(',')}}`;
    } finally { ancestors.delete(item); }
  }
  return encode(value);
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function actionKey(runId: string, stepSeq: number, tool: string, args: unknown): string {
  return hash([runId, stepSeq, tool, args]);
}
