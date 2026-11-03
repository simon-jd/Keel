import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { postgres } from './postgres.js';
import type { ChatChunk, ChatRequest, ModelClient } from 'models/types';
import { PostgresStore } from '../src/store.js';
import type { Task } from '../src/types.js';

export const task: Task = { tenantId: 'tenant-a', input: 'fixture task', model: 'local', capabilities: ['read', 'write'] };
export const call = (args: unknown = { value: 1 }, name = 'counter.read'): ChatChunk => ({ toolCalls: [{ id: 'call-1', name, args }] });
export function scripted(chunks: ChatChunk[], inspect?: (request: ChatRequest) => void): ModelClient {
  let index = 0;
  return { async *stream(request) { inspect?.(request); yield chunks[Math.min(index++, chunks.length - 1)]!; } };
}
export async function database() {
  const container = await postgres('runtime-tests');
  const url = container.getConnectionUri();
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(await readFile(new URL('../../db/migrations/0001_initial.up.sql', import.meta.url), 'utf8'));
  await client.query('CREATE TABLE effect_counter (action_key text PRIMARY KEY, n integer NOT NULL)');
  return { container, client, url, store: new PostgresStore(url) };
}
