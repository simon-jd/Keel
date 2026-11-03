import { azureDispatchBody, isAzureJudgeRoute, settleAzureDispatch } from './azureCommercial.js';
import type { ChatChunk, ChatRequest, Route } from './types.js';
import { complete, events, json, ModelError, openaiMessages, post, privateJudgeResponse, record, token } from './protocol.js';
import { parseVerdict } from '../../evals/src/judge.js';
import type { AttemptState, PendingTool } from './protocol.js';
import {isLocalJudgeRoute} from './localJudgeProfile.js';

/** One attempt. Only the router commits its result after this function returns. */
export async function openai(req: ChatRequest, route: Route, signal: AbortSignal, state: AttemptState): Promise<ChatChunk> {
  let responseResult: ChatChunk | undefined;
  let outcome: 'valid' | 'invalid-schema' | 'failed' = 'failed';
  try {
    const result = await openaiAttempt(req, route, signal, state);
    if (isAzureJudgeRoute(route)) {
      try { if (result.toolCalls?.length || result.invalidToolCalls?.length) throw new Error(); parseVerdict(result.text ?? ''); outcome = 'valid'; } catch { outcome = 'invalid-schema'; }
      result.providerResponse = privateJudgeResponse(state);
    }
    responseResult = result; return result;
  } finally {
    state.judgeOutcome = outcome;
    if (state.azureAttempt !== undefined) {
      state.settlementStatus = 'unknown';
      await settleAzureDispatch(route, state.azureAttempt, state.usageFinal ? state.usage : undefined, outcome);
      state.settlementStatus = 'validated';
      if (responseResult?.providerResponse) responseResult.providerResponse.settlementStatus = 'validated';
    }
  }
}
async function openaiAttempt(req: ChatRequest, route: Route, signal: AbortSignal, state: AttemptState): Promise<ChatChunk> {
  const response = await post(route, 'chat/completions', route.provider === 'azureCommercial' ? azureDispatchBody(req, route) : {
    model: route.model, messages: openaiMessages(req), stream: true, stream_options: { include_usage: true },
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.seed === undefined ? {} : { seed: req.seed }),
    ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
    ...(route.responseFormat === undefined ? {} : { response_format: route.responseFormat }),
    ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ type: 'function', function: { name: tool.name, parameters: tool.parameters, ...(tool.description === undefined ? {} : { description: tool.description }) } })) }),
  }, signal, state);
  let text = '';
  let finished = false;
  let finishReason = '';
  const tools = new Map<number, PendingTool>();
  let judgeDone: ChatChunk | undefined;
  for await (const event of events(response, signal, isAzureJudgeRoute(route)||isLocalJudgeRoute(route) ? state : undefined)) {
    if (judgeDone) throw new ModelError('protocol');
    if (event.event === 'error') throw new ModelError('protocol');
    if (event.data === '[DONE]') {
      if (!finished || (tools.size > 0 && finishReason !== 'tool_calls')) throw new ModelError('protocol');
      const result = complete(text, [...tools.entries()].sort(([a],[b])=>a-b).map(([,tool])=>tool), req, state);
      if (isAzureJudgeRoute(route)||isLocalJudgeRoute(route)) { judgeDone = result; continue; }
      return result;
    }
    const value = json(event.data);
    if (value.error) throw new ModelError('protocol');
    if (value.usage !== undefined && value.usage !== null) {
      const usage = record(value.usage);
      state.usage = { input: token(usage.prompt_tokens), output: token(usage.completion_tokens) };
      state.usageFinal = true;
    }
    if (!Array.isArray(value.choices)) throw new ModelError('protocol');
    for (const raw of value.choices) {
      const choice = record(raw);
      if (choice.index !== 0) throw new ModelError('protocol');
      const delta = record(choice.delta);
      if (typeof delta.content === 'string') text += delta.content;
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) throw new ModelError('protocol');
        for (const rawCall of delta.tool_calls) {
          const call = record(rawCall);
          const index = token(call.index);
          const tool = tools.get(index) ?? { id: '', name: '', json: '' };
          if (call.id !== undefined) { if (typeof call.id !== 'string') throw new ModelError('protocol'); tool.id += call.id; }
          if (call.function !== undefined) {
            const fn = record(call.function);
            if (Object.hasOwn(fn, 'name')) {
              if (typeof fn.name !== 'string') throw new ModelError('protocol');
              tool.name += fn.name;
            }
            if (Object.hasOwn(fn, 'arguments')) {
              if (typeof fn.arguments !== 'string') throw new ModelError('protocol');
              tool.json += fn.arguments;
            }
          }
          tools.set(index, tool);
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(String(choice.finish_reason))) throw new ModelError('protocol');
        finished = true;
        finishReason = String(choice.finish_reason);
      }
    }
  }
  if (judgeDone) return judgeDone;
  throw new ModelError('protocol');
}
