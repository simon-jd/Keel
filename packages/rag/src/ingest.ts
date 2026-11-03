import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { embeddingProfile, validateVector } from 'models/rag';
import type { EmbeddingClient } from 'models/rag';
import type { CallAccounting } from 'models/types';

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const NORMALIZER = 'markdown-lines-v2';
export const MAX_CHARS = 1200;
export type Chunk = { id: string; docId: string; version: string; text: string; contentHash: string; sourceUrl: string; startLine: number; endLine: number; startOffset: number; endOffset: number; tainted: true };
export type SourceFile = { path: string; url: string; gitBlobSha: string; bytes: number; sha256: string };
export type CorpusLock = { version: string; upstream: { repository: string; commit: string; rootTree: string; release: string }; license: string; attribution: string; modifiedNotice: string; normalizer: string; maxChars: number; sources: SourceFile[]; chunksHash: string; chunkCount: number; omissions: { docId: string; line: number; kind: string }[] };
/** Keep Markdown, remove YAML/comments/wrappers, retain literal glossary text only; never resolve includes. */
export function normalize(markdown: string) {
  const omissions: { line: number; kind: string }[] = [];
  let text = markdown.replaceAll('\r\n', '\n');
  const newlines = (value: string) => '\n'.repeat(value.split('\n').length - 1);
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end < 0) throw new Error('UNTERMINATED_MARKDOWN_METADATA');
    const boundary = end + 4;
    text = newlines(text.slice(0, boundary)) + text.slice(boundary);
  }
  text = text.replace(/<!--[\s\S]*?-->/g, value => newlines(value));
  if (text.includes('<!--')) throw new Error('UNTERMINATED_MARKDOWN_METADATA');
  const source = text;
  text = text.replace(/\{\{[<%]([\s\S]*?)[>%]\}\}/g, (full: string, body: string, offset: number) => {
    const kind = body.trim().split(/\s/)[0] ?? 'unknown';
    let replacement = '';
    if (kind === 'glossary_tooltip') {
      const match = /\btext="([^"]*)"/.exec(body);
      if (match) replacement = match[1]!;
      else omissions.push({ line: source.slice(0, offset).split('\n').length, kind });
    } else if (!['note','/note','warning','/warning','caution','/caution','tabs','/tabs','tab','/tab','capture','/capture'].includes(kind)) {
      omissions.push({ line: source.slice(0, offset).split('\n').length, kind });
    }
    return replacement + newlines(full);
  });
  if (/\{\{[<%]|[>%]\}\}/.test(text)) throw new Error('UNRESOLVED_TEMPLATE_BOUNDARY');
  const lines = text.split('\n').map((value, index) => ({ line: index + 1, text: value.trimEnd() })).filter(value => value.text.trim());
  return { lines, omissions };
}
export function chunkDocument(version: string, docId: string, markdown: string, sourceUrl: string, maxChars = MAX_CHARS): Chunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 16) throw new Error('INVALID_CHUNK_SIZE');
  const { lines } = normalize(markdown); const text = lines.map(x => x.text).join('\n'); const spans: { start: number; end: number; line: number }[] = []; let offset = 0;
  for (const line of lines) { spans.push({ start: offset, end: offset + line.text.length, line: line.line }); offset += line.text.length + 1; }
  const chunks: Chunk[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) { const boundary = text.lastIndexOf('\n', end); if (boundary > start + maxChars / 2) end = boundary; }
    const value = text.slice(start, end); const contentHash = sha256(value);
    const startLine = spans.find(x => x.end > start)?.line; const endLine = spans.find(x => x.end >= end)?.line;
    if (startLine === undefined || endLine === undefined) throw new Error('INVALID_LINE_PROVENANCE');
    chunks.push({ id: sha256(JSON.stringify([version, docId, start, end, contentHash])), docId, version, text: value, contentHash, sourceUrl, startLine, endLine, startOffset: start, endOffset: end, tainted: true });
    start = end; if (text[start] === '\n') start++;
  }
  return chunks;
}
// Reviewed commitment to the immutable checked-in lock, independent of ingest caller input.
export const OFFICIAL_CORPUS_VERSION = '685b6988b39330405ff97cc69fcf7d600f963a55615e4653be04722cb95be356';
export const OFFICIAL_LOCK_DIGEST = 'f85cb5bf4a421768f5c5b8977d812462f5d810b0213bcf6d1b22a8ae9d2336df';
export type FixtureCorpusAdmission = { scope: 'fixture'; expectedLockDigest: string };
export const corpusLockDigest = (lock: CorpusLock) => sha256(canonical(lock));
export function verifyCorpus(lock: CorpusLock, chunks: Chunk[], fixture?: FixtureCorpusAdmission) {
  const digest = corpusLockDigest(lock);
  const approved = fixture === undefined
    ? lock.version === OFFICIAL_CORPUS_VERSION && digest === OFFICIAL_LOCK_DIGEST
    : fixture.scope === 'fixture' && lock.version !== OFFICIAL_CORPUS_VERSION
      && /^[a-f0-9]{64}$/.test(fixture.expectedLockDigest) && digest === fixture.expectedLockDigest;
  if (!approved) throw new Error('UNAPPROVED_CORPUS');
  const { version: _, chunksHash: _h, chunkCount: _c, omissions: _o, ...spec } = lock;
  if (sha256(JSON.stringify(spec)) !== lock.version || sha256(JSON.stringify(chunks)) !== lock.chunksHash || chunks.length !== lock.chunkCount || !chunks.length || new Set(chunks.map(c => c.id)).size !== chunks.length) throw new Error('CORPUS_LOCK_MISMATCH');
  const docs = new Map(lock.sources.map(s => [s.path, s.url]));
  for (const c of chunks) if (c.version !== lock.version || c.contentHash !== sha256(c.text) || c.id !== sha256(JSON.stringify([c.version, c.docId, c.startOffset, c.endOffset, c.contentHash])) || c.tainted !== true || docs.get(c.docId) !== c.sourceUrl || c.startLine < 1 || c.endLine < c.startLine || c.endOffset - c.startOffset !== c.text.length) throw new Error('CHUNK_MISMATCH');
}
/** One transaction and per corpus/profile lock. Model failures roll back every inserted chunk. Dedicated Client required. */
export async function ingest(db: Client, lock: CorpusLock, chunks: Chunk[], embeddings: EmbeddingClient, signal: AbortSignal, fixture?: FixtureCorpusAdmission) {
  lock = structuredClone(lock);
  chunks = structuredClone(chunks);
  verifyCorpus(lock, chunks, fixture); const embed = embeddings.embed.bind(embeddings);
  const profile = embeddingProfile(embeddings.profile);
  if (profile.id !== embeddings.profile.id) throw new Error('EMBEDDING_PROFILE_MISMATCH');
  const calls: CallAccounting[] = []; const run_id = randomUUID();
  let stage = 'begin';
  const query = (operation: string, sql: string, values?: unknown[]) => {
    stage = operation;
    return db.query(sql, values);
  };
  try {
    await query('begin', 'BEGIN');
    await query('transaction-lock', 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lock.version + profile.id]);
    const saved = await query('read-corpus', 'SELECT lock FROM rag_corpora WHERE version=$1', [lock.version]);
    if (saved.rows[0] && JSON.stringify(saved.rows[0].lock) !== JSON.stringify(JSON.parse(JSON.stringify(lock)))) {
      // jsonb key order differs: compare semantically below, not serialized property order.
      if (canonical(saved.rows[0].lock) !== canonical(lock)) throw new Error('CORPUS_CONFLICT');
    }
    await query('insert-corpus', 'INSERT INTO rag_corpora(version,lock) VALUES($1,$2) ON CONFLICT DO NOTHING', [lock.version, lock]);
    await query('insert-profile', 'INSERT INTO rag_embedding_profiles(id,dimension,profile) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [profile.id, profile.dimension, profile]);
    const existingProfile = await query('read-profile', 'SELECT profile FROM rag_embedding_profiles WHERE id=$1', [profile.id]);
    if (canonical(existingProfile.rows[0]?.profile) !== canonical(profile)) throw new Error('PROFILE_CONFLICT');
    const existing = await query('read-chunks', 'SELECT id FROM chunks WHERE version=$1 AND profile_id=$2 ORDER BY id', [lock.version, profile.id]);
    if (existing.rows.length) {
      if (existing.rows.map(r => r.id).sort().join(',') !== chunks.map(c => c.id).sort().join(',')) throw new Error('PARTIAL_CORPUS');
      await query('commit', 'COMMIT'); return { inserted: 0, calls };
    }
    for (let i = 0; i < chunks.length; i += 32) {
      stage = 'embedding';
      const batch = chunks.slice(i, i + 32); const result = await embed(batch.map(c => c.text), { signal, run_id, call_id: `${run_id}:${i / 32 + 1}` }); calls.push(structuredClone(result.accounting));
      const vectors = structuredClone(result.vectors);
      if (result.profile.id !== profile.id || vectors.length !== batch.length) throw new Error('EMBEDDING_RESPONSE_MISMATCH');
      for (const [index, c] of batch.entries()) {
        const vector = vectors[index]; validateVector(vector, profile.dimension);
        await query('insert-chunk', 'INSERT INTO chunks(id,doc_id,version,profile_id,dimension,text,content_hash,provenance,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)', [c.id,c.docId,c.version,profile.id,profile.dimension,c.text,c.contentHash,c,JSON.stringify(vector)]);
      }
    }
    await query('commit', 'COMMIT'); return { inserted: chunks.length, calls };
  } catch (error) {
    const accounting = (error as { accounting?: CallAccounting }).accounting;
    if (accounting) calls.push(structuredClone(accounting));
    const primaryFailure = sanitizedFailure(stage, error);
    let cleanupFailure: ReturnType<typeof sanitizedFailure> | null = null;
    try { await db.query('ROLLBACK'); }
    catch (cleanup) { cleanupFailure = sanitizedFailure('rollback', cleanup); }
    throw Object.assign(new Error('INGEST_FAILED'), { calls, primaryFailure, cleanupFailure });
  }
}
function sanitizedFailure(stage: string, error: unknown) {
  const value = error as { code?: unknown; message?: unknown } | null;
  const modelCodes = ['configuration','invalid_request','http','network','protocol','aborted','budget_denied','budget_exhausted'];
  const internalCodes = ['CORPUS_CONFLICT','PROFILE_CONFLICT','PARTIAL_CORPUS','EMBEDDING_RESPONSE_MISMATCH'];
  const code = typeof value?.code === 'string' && (/^[0-9A-Z]{5}$/.test(value.code) || modelCodes.includes(value.code))
    ? value.code : typeof value?.message === 'string' && internalCodes.includes(value.message)
      ? value.message : 'INGEST_OPERATION_FAILED';
  return { stage, code };
}

function canonical(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}'; }
