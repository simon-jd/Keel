import type { ChatChunk, ChatRequest, Route } from './types.js';
import { complete, events, json, ModelError, post, record, token } from './protocol.js';
import type { AttemptState, PendingTool } from './protocol.js';

export async function anthropic(req: ChatRequest, route: Route, signal: AbortSignal, state: AttemptState): Promise<ChatChunk> {
  const response = await post(route, 'messages', {
    model: route.model, stream: true, max_tokens: req.maxTokens ?? 4096,
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.messages.some((message) => message.role === 'system') ? { system: req.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n') } : {}),
    messages: req.messages.filter((message) => message.role !== 'system').map((message) => {
      if (message.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }] };
      return { role: message.role, content: [...(message.content ? [{ type: 'text', text: message.content }] : []), ...(message.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))] };
    }),
    ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ name: tool.name, input_schema: tool.parameters, ...(tool.description === undefined ? {} : { description: tool.description }) })) }),
  }, signal);
  let text = '';
  let started = false;
  let finished = false;
  let stopReason: unknown;
  const tools = new Map<number, PendingTool>();
  const blocks = new Set<number>();
  for await (const event of events(response, signal)) {
    const value = json(event.data);
    if (event.event === 'error' || value.type === 'error') throw new ModelError('protocol');
    switch (value.type) {
      case 'message_start': {
        if (started) throw new ModelError('protocol');
        started = true;
        const usage = record(record(value.message).usage);
        state.usage = { input: token(usage.input_tokens), output: token(usage.output_tokens) };
        break;
      }
      case 'content_block_start': {
        const index = token(value.index);
        if (!started || blocks.has(index)) throw new ModelError('protocol');
        blocks.add(index);
        const block = record(value.content_block);
        if (block.type === 'tool_use') {
          if (typeof block.id !== 'string' || typeof block.name !== 'string') throw new ModelError('protocol');
          tools.set(index, { id: block.id, name: block.name, json: '' });
        } else if (block.type === 'text' && typeof block.text === 'string') text += block.text;
        break;
      }
      case 'content_block_delta': {
        const index = token(value.index);
        if (!blocks.has(index)) throw new ModelError('protocol');
        const delta = record(value.delta);
        if (delta.type === 'text_delta' && typeof delta.text === 'string') text += delta.text;
        if (delta.type === 'input_json_delta') {
          const tool = tools.get(index);
          if (!tool || typeof delta.partial_json !== 'string') throw new ModelError('protocol');
          tool.json += delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const index = token(value.index);
        if (!blocks.delete(index)) throw new ModelError('protocol');
        // No deltas is the documented representation of an empty tool input.
        const tool = tools.get(index);
        if (tool && !tool.json) tool.json = '{}';
        break;
      }
      case 'message_delta': {
        if (!started || !state.usage) throw new ModelError('protocol');
        const usage = record(value.usage);
        // Anthropic output usage is cumulative, never an incremental addition.
        state.usage = { input: state.usage.input, output: token(usage.output_tokens) };
        stopReason = record(value.delta).stop_reason;
        if (stopReason) { finished = true; state.usageFinal = true; }
        break;
      }
      case 'message_stop':
        if (!started || !finished || blocks.size || (tools.size > 0 && stopReason !== 'tool_use')) throw new ModelError('protocol');
        return complete(text, [...tools.entries()].sort(([a],[b])=>a-b).map(([,tool])=>tool), req, state);
      default: // ping and future extension events do not commit a response.
        break;
    }
  }
  throw new ModelError('protocol');
}
