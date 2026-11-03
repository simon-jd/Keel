import { Client } from 'pg';
import { z } from 'zod';
import { runAgent } from '../src/loop.js';
import { defineTool } from '../src/tools.js';
import { PostgresStore } from '../src/store.js';
import { call, scripted, task } from './helpers.js';
const client = new Client({ connectionString: process.env.TEST_DATABASE_URL! });
await client.connect();
const tool = defineTool({ name: 'counter.write', schema: z.object({ value: z.number() }), sideEffect: true,
  async run(_args, ctx) {
    await client.query('INSERT INTO effect_counter VALUES ($1,1)', [ctx.actionKey]);
    process.stdout.write('EFFECT_COMMITTED\n');
    await new Promise(() => {});
  },
});
const id = process.env.TEST_RUN_ID!;
const deps = { store: new PostgresStore(process.env.TEST_DATABASE_URL!), model: scripted([call({ value: 1 }, tool.name)]), tools: [tool] };
const waiting = await runAgent(id, task, deps);
await runAgent(id, task, { ...deps, approvals: [waiting.approval!] });
