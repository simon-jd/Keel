import { request } from 'node:http';
import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

type Item = { id: string; text: string };
const MAX_BODY_BYTES = 65_536;
const MAX_TEXT_BYTES = 49_152;
const MAX_ITEMS = 128;
const MAX_TEXT_CHARS = 4096;
const DEADLINE_MS = 200;
function failure(): Error { const error = new Error('TRACE_EXPORT_FAILED'); delete error.stack; return error; }

/** Trusted fixed loopback configuration only; no DNS, redirects, credentials or caller-supplied URL. */
function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('INVALID_PII_ENDPOINT'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/redact') throw new Error('INVALID_PII_ENDPOINT');
  return url;
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Absolute deadline includes response streaming. Every failure resolves to omission, never original text. */
function redact(url: URL, items: Item[]): Promise<Item[] | undefined> {
  return new Promise(resolve => {
    let settled = false;
    let req: ReturnType<typeof request> | undefined;
    const finish = (result?: Item[]) => {
      if (settled) return;
      settled = true; clearTimeout(timer); req?.destroy(); resolve(result);
    };
    const timer = setTimeout(() => finish(), DEADLINE_MS);
    try {
      const body = Buffer.from(JSON.stringify({ items }));
      if (body.length > MAX_BODY_BYTES) { finish(); return; }
      req = request(url, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length } }, res => {
        if (res.statusCode !== 200 || res.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { res.destroy(); finish(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) { res.destroy(); finish(); return; }
          chunks.push(chunk);
        });
        res.on('error', () => finish()); res.on('aborted', () => finish());
        res.on('end', () => {
          if (settled) return;
          try {
            const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (!isObject(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.items) || parsed.items.length !== items.length) { finish(); return; }
            const result: Item[] = [];
            for (const [index, value] of parsed.items.entries()) {
              if (!isObject(value) || Object.keys(value).length !== 2 || value.id !== items[index]!.id || typeof value.text !== 'string' || value.text.length > MAX_TEXT_CHARS) { finish(); return; }
              result.push({ id: value.id as string, text: value.text });
            }
            finish(result);
          } catch { finish(); }
        });
      });
      req.on('error', () => finish()); req.end(body);
    } catch { finish(); }
  });
}

/**
 * Awaited pre-export stage, used BETWEEN whole-envelope privacy projections.
 * Only already-whitelisted metadata enters this service. Failure drops every
 * string in the batch; metrics survive. Input spans are never mutated.
 */
export function createPiiExporter(exporter: SpanExporter, options: { endpoint: string }): SpanExporter {
  const url = endpoint(options.endpoint);
  const pending = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    export(spans, callback) {
      let called = false;
      const finish: Parameters<SpanExporter['export']>[1] = result => {
        if (called) return;
        called = true; callback(result.code === 0 ? { code: 0 } : { code: 1, error: failure() });
      };
      if (closed) { finish({ code: 1 }); return; }
      // Snapshot attributes before asynchronous work. Raw SDK objects remain private to their other owners.
      let snapshots: ReadableSpan[];
      try { snapshots = spans.map(span => ({ ...span, attributes: { ...span.attributes }, spanContext: () => span.spanContext() })); }
      catch { finish({ code: 1 }); return; }
      const work = (async () => {
        const items: Item[] = []; const positions: { span: number; key: string }[] = [];
        let bytes = 0; let bounded = true;
        for (const [index, span] of snapshots.entries()) {
          for (const [key, value] of Object.entries(span.attributes)) {
            if (typeof value !== 'string') continue;
            bytes += Buffer.byteLength(value);
            if (!value || value.length > MAX_TEXT_CHARS || items.length >= MAX_ITEMS || bytes > MAX_TEXT_BYTES) { bounded = false; continue; }
            items.push({ id: String(items.length), text: value }); positions.push({ span: index, key });
          }
        }
        const result = bounded && items.length ? await redact(url, items) : undefined;
        const safe: ReadableSpan[] = snapshots.map(span => ({ ...span, attributes: Object.fromEntries(Object.entries(span.attributes).filter(([, value]) => typeof value !== 'string')) as Attributes }));
        if (result) for (const [index, item] of result.entries()) safe[positions[index]!.span]!.attributes[positions[index]!.key] = item.text;
        // No raw fallback, even when validation or the request failed. The final privacy projection revalidates metadata.
        await new Promise<void>(resolve => {
          try { exporter.export(safe, result => { finish(result); resolve(); }); }
          catch { finish({ code: 1 }); resolve(); }
        });
      })().catch(() => finish({ code: 1 }));
      pending.add(work); void work.finally(() => pending.delete(work));
    },
    async forceFlush() { try { await Promise.all([...pending]); await exporter.forceFlush?.(); } catch { throw failure(); } },
    shutdown() {
      if (!closing) { closed = true; closing = (async () => { try { await Promise.all([...pending]); await exporter.shutdown(); } catch { throw failure(); } })(); }
      return closing;
    },
  };
}
