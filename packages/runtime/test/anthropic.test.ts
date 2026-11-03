import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { z } from 'zod';
import { createRouter } from 'models/router';
import { runAgent } from '../src/loop.js';
import { defineTool } from '../src/tools.js';
import { database, task } from './helpers.js';

let db: Awaited<ReturnType<typeof database>>;
beforeAll(async () => { db = await database(); });
afterAll(async () => { await db?.client.end(); await db?.container.stop(); });

type Block = { type: string; id?: string; input?: unknown; tool_use_id?: string; content?: string };
type WireRequest = { messages: { role: string; content: Block[] }[] };

// Hand-authored protocol fixture, not a recording or a paid provider request.
function response(calls: { id: string; json: string }[]): string {
  const events: Record<string, unknown>[] = [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }];
  if (!calls.length) events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'finished' } }, { type: 'content_block_stop', index: 0 });
  calls.forEach((call, index) => events.push(
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: 'counter.read', input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.json } },
    { type: 'content_block_stop', index },
  ));
  events.push({ type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 4 } }, { type: 'message_stop' });
  return events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

// Catches a runtime correction transcript which the actual Anthropic adapter turns into invalid HTTP input.
test.each([
  { invalid: 'type', corrects: true }, { invalid: 'json', corrects: true },
  { invalid: 'type', corrects: false }, { invalid: 'json', corrects: false },
])('Anthropic HTTP correction preserves object inputs and retry cap: $invalid / $corrects', async ({ invalid, corrects }) => {
  const requests: WireRequest[] = [];
  const rejected: string[] = [];
  const executed: number[] = [];
  const server = createServer(async (request, reply) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as WireRequest;
    requests.push(body);
    // Anthropic combines consecutive same-role turns; tool results must immediately follow all matching uses.
    for (let index = 0; index < body.messages.length; index++) {
      const message = body.messages[index]!;
      const uses = message.content.filter(block => block.type === 'tool_use');
      if (!uses.length) continue;
      if (uses.some(block => !block.input || typeof block.input !== 'object' || Array.isArray(block.input))) rejected.push('tool_use.input must be an object');
      const results: Block[] = [];
      for (let next = index + 1; body.messages[next]?.role === 'user'; next++) results.push(...body.messages[next]!.content);
      if (results.length !== uses.length || results.some((block, i) => block.type !== 'tool_result' || block.tool_use_id !== uses[i]?.id)) rejected.push('tool_result IDs/order invalid');
    }
    if (rejected.length) { reply.writeHead(400); reply.end('invalid fixture request'); return; }
    const attempt = requests.length;
    const bad = !corrects || attempt < 3;
    reply.writeHead(200, { 'Content-Type': 'text/event-stream' });
    reply.end(response(bad ? [
      { id: `bad-${attempt}`, json: invalid === 'json' ? '{"value":INVALID_FIXTURE}' : '{"value":"wrong-type"}' },
      { id: `sibling-${attempt}`, json: '{"value":123}' },
    ] : attempt === 3 ? [{ id: 'corrected', json: '{"value":7}' }] : []));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  try {
    const model = createRouter({ local: { provider: 'anthropic', model: 'manual-protocol-fixture', endpoint: `http://127.0.0.1:${address.port}`, pricing: { inputPerMillion: 0, outputPerMillion: 0 } } });
    const result = await runAgent(randomUUID(), task, {
      store: db.store, model,
      tools: [defineTool({ name: 'counter.read', schema: z.object({ value: z.number() }), sideEffect: false, async run(args) { executed.push(args.value); return args.value; } })],
    });
    expect(result).toMatchObject(corrects
      ? { status: 'DONE', output: 'finished', budget: { modelCalls: 4, toolCalls: 1 } }
      : { status: 'FAILED', errorCode: 'INVALID_TOOL_ARGS', budget: { modelCalls: 3, toolCalls: 0 } });
    expect(executed).toEqual(corrects ? [7] : []);
    expect(rejected).toEqual([]);
    expect(requests).toHaveLength(corrects ? 4 : 3);
    const correction = requests[1]!.messages.slice(1);
    expect(correction[0]!.content.map(block => block.input)).toEqual([{}, {}]);
    expect(correction.slice(1).flatMap(message => message.content.map(block => block.content))).toEqual([
      '{"error":"INVALID_TOOL_ARGS"}', '{"error":"INVALID_TOOL_ARGS"}',
    ]);
    expect(JSON.stringify(correction)).not.toContain('INVALID_FIXTURE');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
