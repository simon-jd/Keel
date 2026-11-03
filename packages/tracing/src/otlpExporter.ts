import { diag } from '@opentelemetry/api';
import { OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { convertLegacyHttpOptions, createOtlpHttpExportDelegate } from '@opentelemetry/otlp-exporter-base/node-http';
import { ProtobufTraceSerializer, TraceExporterMetricsHelper } from '@opentelemetry/otlp-transformer';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

/**
 * Keep the official pinned OTLP transport/config/serialization. Own the response
 * boundary BEFORE 0.223's delegate can log malformed bytes or free-text partial
 * success. HTTP success callback semantics remain upstream's semantics; this is
 * an acknowledgement, never proof of Langfuse persistence.
 */
export function createSafeOtlpExporter(config: OTLPExporterNodeConfigBase): SpanExporter {
  const serializer: typeof ProtobufTraceSerializer = {
    serializeRequest: spans => ProtobufTraceSerializer.serializeRequest(spans),
    deserializeResponse(bytes) {
      try {
        const response = ProtobufTraceSerializer.deserializeResponse(bytes);
        if (!response.partialSuccess) return {};
        const count = response.partialSuccess.rejectedSpans;
        return { partialSuccess: {
          ...(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? { rejectedSpans: count } : {}),
          ...(response.partialSuccess.errorMessage ? { errorMessage: 'TRACE_OTLP_PARTIAL_SUCCESS' } : {}),
        } };
      } catch {
        // Never rethrow to upstream: it would log the response bytes alongside the error.
        diag.warn('TRACE_OTLP_INVALID_RESPONSE');
        return {};
      }
    },
  };
  return new OTLPExporterBase<ReadableSpan[]>(createOtlpHttpExportDelegate(
    convertLegacyHttpOptions(config, 'TRACES', 'v1/traces', { 'Content-Type': 'application/x-protobuf' }),
    serializer, 'otlp_http_span_exporter', TraceExporterMetricsHelper, config.selfObsMeterProvider,
  ));
}
