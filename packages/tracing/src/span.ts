import { AsyncLocalStorage } from 'node:async_hooks';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Context, Span, Tracer } from '@opentelemetry/api';

const active = new AsyncLocalStorage<Context>();
let tracer: Tracer | undefined;
/** Local provider injection avoids changing other libraries' global OTel configuration. */
export function installTracer(value: Tracer): () => void {
  const previous = tracer; tracer = value;
  return () => { if (tracer === value) tracer = previous; };
}
export type SafeSpan = { setAttributes(attrs: Record<string, unknown>): void };
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function safeAttributes(attrs: Record<string, unknown>): Attributes {
  const safe: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'keel.attempt_count', 'keel.unknown_attempt_count'].includes(key)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
    } else if (key === 'keel.cost_usd') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = value;
    } else if (typeof value === 'string') {
      if ((key === 'gen_ai.system' || key === 'gen_ai.provider.name') && ['openai', 'anthropic', 'openaiCompatible', 'azureCommercial'].includes(value)) safe[key] = value;
      else if (key === 'keel.cost_status' && ['known', 'unknown'].includes(value)) safe[key] = value;
      else if (key === 'gen_ai.operation.name' && ['chat', 'execute_tool', 'retrieval'].includes(value)) safe[key] = value;
      else if (key === 'error.type' && value === 'operation_failed') safe[key] = value;
      else if (key === 'gen_ai.request.model' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)) safe[key] = value;
      else if (key === 'keel.run_id' && new RegExp(`^${uuid}$`, 'i').test(value)) safe[key] = value;
      else if (key === 'keel.call_id' && new RegExp(`^${uuid}:[0-9]+$`, 'i').test(value)) safe[key] = value;
    }
  }
  return safe;
}
/** Only metrics and operator-controlled model identifiers cross this boundary; never content or raw errors. */
export async function withSpan<T>(kind: 'llm' | 'tool' | 'retrieval', attrs: Record<string, unknown>, fn: (span: SafeSpan) => T | Promise<T>): Promise<T> {
  const parent = active.getStore() ?? context.active();
  let span: Span | undefined;
  try { span = tracer?.startSpan(kind, { kind: kind === 'llm' ? SpanKind.CLIENT : SpanKind.INTERNAL, attributes: { ...safeAttributes(attrs), 'gen_ai.operation.name': kind === 'llm' ? 'chat' : kind === 'tool' ? 'execute_tool' : 'retrieval' } }, parent); } catch { /* Telemetry cannot prevent the operation. */ }
  const handle: SafeSpan = { setAttributes(values) { try { span?.setAttributes(safeAttributes(values)); } catch { /* No model retry for telemetry failure. */ } } };
  try { return await active.run(span ? trace.setSpan(parent, span) : parent, () => fn(handle)); }
  catch (error) {
    try { span?.setStatus({ code: SpanStatusCode.ERROR }); span?.setAttribute('error.type', 'operation_failed'); } catch { /* Preserve the original error. */ }
    throw error;
  } finally { try { span?.end(); } catch { /* Export failure is never an operation failure. */ } }
}
