import { authorizeAzureDispatch, isAzureJudgeRoute, pacedJudgeFetch, assertProtectedJudgeRoute } from './azureCommercial.js';
import type { CallAccounting, ChatChunk, ChatRequest, ObserverStatus, Route, ToolCall, Usage, ProviderResponse } from './types.js';
import {isLocalJudgeRoute} from './localJudgeProfile.js';

export type ErrorCode = 'configuration' | 'invalid_request' | 'http' | 'network' | 'protocol' | 'aborted' | 'budget_denied' | 'budget_exhausted';
/** Messages exclude provider data; Task9 alone carries raw evidence for its private checkpoint. */
export class ModelError extends Error {
  observerStatus?: ObserverStatus;
  accounting?: CallAccounting;
  providerResponse?: ProviderResponse;
  judgeOutcome?: 'valid' | 'invalid-schema' | 'failed';
  constructor(readonly code: ErrorCode, readonly status?: number) {
    super(`Model request failed (${code}${status === undefined ? '' : `:${status}`})`);
    this.name = 'ModelError';
  }
}
export type AttemptState = { usage?: Usage; usageFinal: boolean; azureAttempt?: number; commercialLogical?: number; rawResponse?: string; responseComplete?: boolean; rawByteChunks?: Buffer[]; receivedBytes?: number; capturedBytes?: number; responseTruncated?: boolean; responseTextEncoding?: 'utf-8' | 'invalid-utf-8' | 'undetermined'; httpStatus?: number; judgeOutcome?: 'valid' | 'invalid-schema' | 'failed'; settlementStatus?: 'validated' | 'unknown'; dispatch?: { startedAtMonotonicMs: number; intervalMs: number | null } };
const RESPONSE_BYTE_LIMIT = 1_000_000;
function beginCapture(state: AttemptState): void {
  state.rawByteChunks = []; state.receivedBytes = 0; state.capturedBytes = 0;
  state.responseTruncated = false; state.responseTextEncoding = 'undetermined';
}
/** Retain the bounded received prefix BEFORE decoding, including malformed/over-limit chunks. */
function captureBytes(state: AttemptState, value: Uint8Array): void {
  state.receivedBytes = state.receivedBytes! + value.byteLength;
  const retained = Math.min(value.byteLength, RESPONSE_BYTE_LIMIT - state.capturedBytes!);
  if (retained) state.rawByteChunks!.push(Buffer.from(value.subarray(0, retained)));
  state.capturedBytes = state.capturedBytes! + retained;
  if (retained !== value.byteLength) { state.responseTruncated = true; throw new ModelError('protocol'); }
}
/** Only the Task9 private checkpoint receives these bytes; text/hash semantics remain UTF-8. */
export function privateJudgeResponse(state: AttemptState): ProviderResponse {
  return { raw: state.rawResponse ?? null, complete: state.responseComplete ?? false,
    ...(state.rawByteChunks === undefined ? {} : { bytes: { encoding: 'base64' as const, data: Buffer.concat(state.rawByteChunks).toString('base64'), receivedBytes: state.receivedBytes!, capturedBytes: state.capturedBytes!, truncated: state.responseTruncated!, textEncoding: state.responseTextEncoding! } }),
    ...(state.settlementStatus === undefined ? {} : { settlementStatus: state.settlementStatus }),
    ...(state.dispatch === undefined ? {} : { dispatch: state.dispatch }), ...(state.httpStatus === undefined ? {} : { httpStatus: state.httpStatus }) };
}
export type PendingTool = { id: string; name: string; json: string };
export function aborted(signal: AbortSignal): void { if (signal.aborted) throw new ModelError('aborted'); }
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ModelError('protocol');
  return value as Record<string, unknown>;
}
export function token(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ModelError('protocol');
  return value;
}
export function json(value: string): Record<string, unknown> {
  try { return record(JSON.parse(value) as unknown); } catch { throw new ModelError('protocol'); }
}
export async function post(route: Route, path: string, body: unknown, signal: AbortSignal, state?: AttemptState, responseType: 'events' | 'json' = 'events'): Promise<Response> {
  aborted(signal);
  if (responseType === 'json' && (!['embeddings', 'rerank'].includes(path) || route.provider !== 'openaiCompatible')) throw new ModelError('configuration');
  assertProtectedJudgeRoute(route);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (route.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (route.apiKey) headers['x-api-key'] = route.apiKey;
  } else if (route.apiKey) headers.authorization = `Bearer ${route.apiKey}`;
  const encoded = JSON.stringify(body);
  if (route.provider === 'azureCommercial') {
    if (!state) throw new ModelError('budget_denied');
    const admission = await authorizeAzureDispatch(route, path, body, state.commercialLogical);
    state.azureAttempt = admission.attempt;
    headers['api-key'] = admission.key;
    aborted(signal);
  }
  let response: Response;
  try {
    const start = () => { aborted(signal); return fetch(`${route.endpoint.replace(/\/$/, '')}/${path}`, { method: 'POST', headers, body: encoded, signal, ...(route.provider === 'azureCommercial' || isLocalJudgeRoute(route) || responseType === 'json' ? { redirect: 'error' as const } : {}) }); };
    response = isAzureJudgeRoute(route) ? await pacedJudgeFetch(route, timing => { state!.dispatch = timing; return start(); }) : await start();
  }
  catch { aborted(signal); throw new ModelError('network'); }
  if (state && isAzureJudgeRoute(route)) {
    state.httpStatus = response.status;
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      const reader = response.body?.getReader(); beginCapture(state);
      try { if (reader) while (true) { const next = await reader.read(); if (next.done) { state.responseComplete = true; break; } captureBytes(state, next.value); } }
      finally {
        try {
          if (reader) state.rawResponse = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(state.rawByteChunks!), { stream: !state.responseComplete });
          if (state.responseComplete) state.responseTextEncoding = 'utf-8';
        } catch { state.responseTextEncoding = 'invalid-utf-8'; delete state.rawResponse; }
        await reader?.cancel().catch(() => undefined); reader?.releaseLock();
      }
    }
  }
  if (!response.ok) {
    // Discard without ever decoding a potentially sensitive provider body.
    void response.body?.cancel().catch(() => undefined);
    throw new ModelError('http', response.status);
  }
  if (!response.headers.get('content-type')?.startsWith(responseType === 'json' ? 'application/json' : 'text/event-stream') || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new ModelError('protocol');
  }
  return response;
}

/** Handles line boundaries independently of UTF-8 and HTTP chunk boundaries. */
export async function* events(response: Response, signal: AbortSignal, capture?: AttemptState): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw new ModelError('protocol');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  if (capture) beginCapture(capture);
  let event = 'message';
  let data: string[] = [];
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      aborted(signal);
      const next = await reader.read();
      if (capture && next.value) captureBytes(capture, next.value);
      if (capture && next.done) capture.responseComplete = true;
      let decoded: string;
      try { decoded = decoder.decode(next.value, { stream: !next.done }); }
      catch (error) { if (capture) { capture.responseTextEncoding = 'invalid-utf-8'; delete capture.rawResponse; } throw error; }
      if (capture) capture.rawResponse = (capture.rawResponse ?? '') + decoded;
      if (capture && next.done) capture.responseTextEncoding = 'utf-8';
      aborted(signal);
      buffer += decoded;
      let lineEnd: number;
      while ((lineEnd = buffer.search(/[\r\n]/)) !== -1) {
        // A CR at the chunk boundary might be the first half of CRLF.
        if (buffer[lineEnd] === '\r' && lineEnd === buffer.length - 1 && !next.done) break;
        const line = buffer.slice(0, lineEnd);
        const width = buffer.slice(lineEnd, lineEnd + 2) === '\r\n' ? 2 : 1;
        buffer = buffer.slice(lineEnd + width);
        if (!line) {
          if (data.length) yield { event, data: data.join('\n') };
          data = []; event = 'message';
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'data') data.push(value);
          if (field === 'event') event = value;
        }
      }
      if (next.done) { if (capture) capture.responseComplete = true; return; } // An unterminated event is intentionally not committed.
    }
  } catch (error) {
    aborted(signal);
    if (error instanceof ModelError) throw error;
    throw new ModelError('network');
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function complete(text: string, pending: Iterable<PendingTool>, req: ChatRequest, state: AttemptState): ChatChunk {
  const chunk: ChatChunk = {};
  if (text) chunk.text = text;
  for (const tool of pending) {
    if (!tool.id || !tool.name) throw new ModelError('protocol');
    (chunk.toolCallOrder ??= []).push(tool.id);
    let args: unknown;
    // No argument text at all (a zero-argument call) means {}; the runtime still schema-checks it.
    try { args = tool.json.trim() === '' ? {} : JSON.parse(tool.json) as unknown; }
    catch { (chunk.invalidToolCalls ??= []).push({ id: tool.id, name: tool.name, error: 'malformed_json' }); continue; }
    if (!req.tools?.some((definition) => definition.name === tool.name)) {
      (chunk.invalidToolCalls ??= []).push({ id: tool.id, name: tool.name, args, error: 'unknown_tool' });
    } else {
      (chunk.toolCalls ??= []).push({ id: tool.id, name: tool.name, args });
    }
  }
  if (state.usageFinal && state.usage) chunk.usage = { ...state.usage };
  return chunk;
}

export function openaiMessages(req: ChatRequest): unknown[] {
  return req.messages.map((message) => ({ role: message.role, content: message.content,
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(message.toolCalls === undefined ? {} : { tool_calls: message.toolCalls.map((call: ToolCall) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }),
  }));
}
