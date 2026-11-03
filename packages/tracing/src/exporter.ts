import { createSafeOtlpExporter } from './otlpExporter.js';
import { createPiiExporter } from './piiProcessor.js';
import { TracerProvider, BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { SpanContext } from '@opentelemetry/api';
import { installTracer, safeAttributes } from './span.js';

const resource = resourceFromAttributes({ 'service.name': 'keel' });
const identity = ({ traceId, spanId, traceFlags }: SpanContext): SpanContext => ({ traceId, spanId, traceFlags });
function exportFailure(): Error {
  const error = new Error('TRACE_EXPORT_FAILED');
  delete error.stack;
  return error;
}
/** Project the entire export envelope, including surfaces outside attributes. */
export function createPrivacyExporter(exporter: SpanExporter): SpanExporter {
  return {
    export(spans, callback) {
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        callback(success ? { code: 0 } : { code: 1, error: exportFailure() });
      };
      try {
        const safe: ReadableSpan[] = spans.map(span => ({
          name: ['llm', 'tool', 'retrieval'].includes(span.name) ? span.name : 'operation',
          kind: span.kind, spanContext: () => identity(span.spanContext()),
          ...(span.parentSpanContext ? { parentSpanContext: identity(span.parentSpanContext) } : {}),
          startTime: span.startTime, endTime: span.endTime, duration: span.duration, ended: span.ended,
          status: { code: span.status.code }, attributes: safeAttributes(span.attributes),
          events: [], links: [], resource, instrumentationScope: { name: 'keel' },
          droppedAttributesCount: span.droppedAttributesCount, droppedEventsCount: span.droppedEventsCount,
          droppedLinksCount: span.droppedLinksCount,
        }));
        exporter.export(safe, result => finish(result.code === 0));
      } catch { finish(false); }
    },
    async shutdown() { try { await exporter.shutdown(); } catch { throw exportFailure(); } },
    ...(exporter.forceFlush ? { forceFlush: async () => { try { await exporter.forceFlush!(); } catch { throw exportFailure(); } } } : {}),
  };
}

/** Signal-specific OTLP endpoint; the built-in OTLP sink always uses the fail-closed loopback PII stage. */
export function configureTracing(options: { exporter?: SpanExporter; endpoint?: string; batch?: boolean; piiEndpoint?: string } = {}) {
  let sink = options.exporter;
  if (!sink) {
    const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (base ? `${base.replace(/\/$/, '')}/v1/traces` : undefined);
    let url: URL;
    try { url = new URL(endpoint ?? ''); } catch { throw new Error('INVALID_OTLP_ENDPOINT'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1/traces')) throw new Error('INVALID_OTLP_ENDPOINT');
    sink = createSafeOtlpExporter({ url: url.href, timeoutMillis: 10_000 });
  }
  const piiEndpoint = options.piiEndpoint ?? (process.env.KEEL_PII_ENDPOINT || (options.exporter ? undefined : 'http://127.0.0.1:18082/redact'));
  const exporter = piiEndpoint !== undefined ? createPrivacyExporter(createPiiExporter(createPrivacyExporter(sink), { endpoint: piiEndpoint })) : createPrivacyExporter(sink);
  const batch = options.batch ?? !options.exporter;
  const processor = batch ? new BatchSpanProcessor({ exporter, maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 1000, exportTimeoutMillis: 10_000 }) : new SimpleSpanProcessor({ exporter });
  const provider = new TracerProvider({ resource, spanProcessors: [processor] });
  const restore = installTracer(provider.getTracer('keel'));
  return { forceFlush: () => provider.forceFlush(), shutdown: async () => { restore(); await provider.shutdown(); } };
}
