import { assertCommercialRoute, assertCommercialAlias, assertProtectedJudgeRoute, isAzureJudgeRoute } from './azureCommercial.js';
import { withSpan } from 'tracing/span';
import { readFileSync } from 'node:fs';
import type { AccountingDelivery, AttemptAdmission, AttemptAccounting, CallAccounting, ChatChunk, ChatRequest, ModelClient, Observer, ObserverStatus, Pricing, Route, StreamOptions, Usage } from './types.js';
import { anthropic } from './anthropic.js';
import { openai } from './openai.js';
import { openaiCompatible } from './openaiCompatible.js';
import { aborted, ModelError, privateJudgeResponse } from './protocol.js';
import {isLocalJudgeRoute,localJudgeIdentityForRoute,validLocalJudgeRequest} from './localJudgeProfile.js';
import type { AttemptState } from './protocol.js';
export { ModelError } from './protocol.js';

type Catalog = { models: Record<string, Pricing & { provider: string }> };
const catalog = JSON.parse(readFileSync(new URL('./prices.json', import.meta.url), 'utf8')) as Catalog;
function pricing(model: string, override?: Pricing): Pricing {
  const price = override ?? (Object.hasOwn(catalog.models, model) ? catalog.models[model] : undefined);
  if (!price || !Number.isFinite(price.inputPerMillion) || !Number.isFinite(price.outputPerMillion) || price.inputPerMillion < 0 || price.outputPerMillion < 0) throw new ModelError('configuration');
  return { inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion };
}
export function cost(usage: Usage, model: string, override?: Pricing): number {
  if (![usage.input, usage.output].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new ModelError('invalid_request');
  const price = pricing(model, override);
  return (usage.input * price.inputPerMillion + usage.output * price.outputPerMillion) / 1_000_000;
}
function validate(req: ChatRequest): void {
  if (req?.seed !== undefined && (!Number.isSafeInteger(req.seed) || req.seed < 0 || req.seed > 2147483647)) throw new ModelError('invalid_request');
  if (!req || typeof req.model !== 'string' || !Array.isArray(req.messages) || !req.messages.length || req.messages.some((message) => !message || !['system', 'user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string' || (message.role === 'tool' && !message.toolCallId)) || (req.temperature !== undefined && (!Number.isFinite(req.temperature) || req.temperature < 0 || req.temperature > 2)) || (req.maxTokens !== undefined && (!Number.isSafeInteger(req.maxTokens) || req.maxTokens <= 0))) throw new ModelError('invalid_request');
  if (req.tools !== undefined && (!Array.isArray(req.tools) || req.tools.some((tool) => !tool || typeof tool.name !== 'string' || !tool.name || typeof tool.parameters !== 'object' || tool.parameters === null || Array.isArray(tool.parameters)) || new Set(req.tools.map((tool) => tool.name)).size !== req.tools.length)) throw new ModelError('invalid_request');
  try { JSON.stringify(req); } catch { throw new ModelError('invalid_request'); }
}
function backoff(ms: number, signal: AbortSignal): Promise<void> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new ModelError('aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
function retryable(error: ModelError): boolean {
  return error.code === 'network' || error.code === 'protocol' || (error.code === 'http' && (error.status === 429 || (error.status !== undefined && error.status >= 500)));
}
async function observe(observer: Observer, event: CallAccounting): Promise<ObserverStatus> {
  // Give the exporter its own object; caller recovery metadata cannot be mutated by it.
  // Exporter failures must never replay a completed, potentially billed provider request.
  try { await observer(structuredClone(event)); return 'delivered'; }
  catch { return 'failed'; }
}
export function createRouter(routes: Record<string, Route>, options: { observer?: Observer; beforeAttempt?: (info: AttemptAdmission) => void | Promise<void> } = {}): ModelClient {
  const configured = new Map<string, Route>();
  for (const [alias, route] of Object.entries(routes)) {
    let url: URL;
    try { url = new URL(route.endpoint); } catch { throw new ModelError('configuration'); }
    if (!alias || !route.model || !['openai', 'anthropic', 'openaiCompatible', 'azureCommercial'].includes(route.provider) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ModelError('configuration');
    if (['openaiCompatible', 'azureCommercial'].includes(route.provider) && !route.pricing) throw new ModelError('configuration');
    assertProtectedJudgeRoute(route, alias);
    localJudgeIdentityForRoute(route,alias);
    if(route.responseFormat!==undefined){
      const format=route.responseFormat;
      if(!['openai','openaiCompatible'].includes(route.provider)||route.commercial!==undefined||format?.type!=='json_schema'||format.json_schema?.strict!==true||! /^[A-Za-z0-9_-]{1,64}$/.test(format.json_schema.name)||!format.json_schema.schema||typeof format.json_schema.schema!=='object'||Array.isArray(format.json_schema.schema))throw new ModelError('configuration');
      try{if(Buffer.byteLength(JSON.stringify(format))>65536)throw new Error();}catch{throw new ModelError('configuration');}
    }
    const price = pricing(route.model, route.pricing);
    if (!route.pricing && catalog.models[route.model]?.provider !== route.provider) throw new ModelError('configuration');
    if (route.provider === 'azureCommercial' || route.commercial !== undefined) { assertCommercialRoute({ ...route, pricing: price }); assertCommercialAlias(route, alias); }
    configured.set(alias, { ...route, pricing: price,...(route.responseFormat===undefined?{}:{responseFormat:structuredClone(route.responseFormat)}) });
  }
  const localJudgeProfile=configured.has('local')?localJudgeIdentityForRoute(configured.get('local')!):undefined;
  return { ...(localJudgeProfile===undefined?{}:{localJudgeProfile}),async *stream(req: ChatRequest, opts: StreamOptions): AsyncGenerator<ChatChunk> {
    aborted(opts.signal);
    validate(req);
    const route = configured.get(req.model);
    if (!route) throw new ModelError('configuration');
    if(isLocalJudgeRoute(route)&&!validLocalJudgeRequest(req))throw new ModelError('invalid_request');
    const result = await withSpan('llm', { 'gen_ai.system': route.provider, 'gen_ai.provider.name': route.provider, 'gen_ai.request.model': route.model, 'keel.run_id': opts.run_id, 'keel.call_id': opts.call_id }, async span => {
      const attempts: AttemptAccounting[] = [];
      const report = async (status: CallAccounting['status'], usage?: Usage): Promise<AccountingDelivery> => {
        const accounting: CallAccounting = {
          ...(opts.run_id === undefined ? {} : { run_id: opts.run_id }), ...(opts.call_id === undefined ? {} : { call_id: opts.call_id }),
          model: route.model, provider: route.provider, status, ...(usage === undefined ? {} : { usage: { ...usage } }),
          costUsd: attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
          costStatus: attempts.some((attempt) => attempt.costStatus === 'unknown') ? 'unknown' : 'known', attempts: structuredClone(attempts),
        };
        const knownUsage = attempts.flatMap(attempt => attempt.usage ? [attempt.usage] : []);
        span.setAttributes({ 'gen_ai.usage.input_tokens': knownUsage.length ? knownUsage.reduce((sum, u) => sum + u.input, 0) : undefined, 'gen_ai.usage.output_tokens': knownUsage.length ? knownUsage.reduce((sum, u) => sum + u.output, 0) : undefined, 'keel.cost_usd': accounting.costUsd, 'keel.cost_status': accounting.costStatus, 'keel.attempt_count': attempts.length, 'keel.unknown_attempt_count': attempts.filter(a => a.costStatus === 'unknown').length });
        return { ...(options.observer ? { observerStatus: await observe(options.observer, accounting) } : {}), accounting };
      };
      for (let index = 0; index <= 4; index++) {
        if (options.beforeAttempt) {
          try {
            aborted(opts.signal);
            await options.beforeAttempt({ alias: req.model, model: route.model, provider: route.provider, attempt: index + 1,
              priorAttempts: structuredClone(attempts), ...(opts.run_id === undefined ? {} : { run_id: opts.run_id }), ...(opts.call_id === undefined ? {} : { call_id: opts.call_id }) });
            aborted(opts.signal);
          } catch {
            const status = opts.signal.aborted ? 'aborted' : 'failed';
            throw Object.assign(new ModelError(opts.signal.aborted ? 'aborted' : 'budget_denied'), await report(status));
          }
        }
        const state: AttemptState = { usageFinal: false, ...(opts.commercialLogical === undefined ? {} : { commercialLogical: opts.commercialLogical }) };
        let result: ChatChunk;
        try {
          aborted(opts.signal);
          const attempt = route.provider === 'anthropic' ? anthropic : route.provider === 'openaiCompatible' ? openaiCompatible : openai;
          result = await attempt(req, route, opts.signal, state);
          aborted(opts.signal);
        } catch (error) {
          const safe = opts.signal.aborted ? new ModelError('aborted') : error instanceof ModelError ? error : new ModelError('protocol');
          if (isAzureJudgeRoute(route)) { safe.providerResponse = privateJudgeResponse(state); if (state.judgeOutcome !== undefined) safe.judgeOutcome = state.judgeOutcome; }
          const known = state.usageFinal && state.usage !== undefined;
          if (route.provider !== 'azureCommercial' || state.azureAttempt !== undefined) attempts.push({ attempt: index + 1, outcome: safe.code === 'aborted' ? 'aborted' : 'failed', costStatus: known ? 'known' : 'unknown', ...(known ? { usage: { ...state.usage! }, costUsd: cost(state.usage!, route.model, route.pricing) } : {}) });
          if (isAzureJudgeRoute(route) || isLocalJudgeRoute(route) || safe.code === 'aborted' || index === 4 || !retryable(safe)) { Object.assign(safe, await report(safe.code === 'aborted' ? 'aborted' : 'failed')); throw safe; }
          try { await backoff(500 * 2 ** index, opts.signal); }
          catch { throw Object.assign(new ModelError('aborted'), await report('aborted')); }
          continue;
        }
        attempts.push({ attempt: index + 1, outcome: 'success', costStatus: result.usage ? 'known' : 'unknown', ...(result.usage ? { usage: { ...result.usage }, costUsd: cost(result.usage, route.model, route.pricing) } : {}) });
        const delivery = await report('success', result.usage);
        if (opts.signal.aborted) throw Object.assign(new ModelError('aborted'), delivery);
        return { ...result, ...delivery };
      }
      throw new ModelError('protocol');
    });
    yield result;
  } };
}
