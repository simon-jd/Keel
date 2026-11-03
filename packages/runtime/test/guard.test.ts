import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import { runAgent } from '../src/loop.js';
import { defineTool } from '../src/tools.js';
import { createHttpFetchTool } from '../src/http.js';
import { createGuard } from '../../guard/src/policy.js';
import { database, scripted } from './helpers.js';
import { createRuntimeTool } from '../../mcp-servers/common/src/bridge.js';
import { startServer } from '../../mcp-servers/common/src/server.js';
import { ApprovalAuthority } from '../../mcp-servers/common/src/approval.js';
import { authConfig, jwt, database as mcpDatabase } from '../../mcp-servers/common/test/helpers.js';
import { ActionJournal } from '../../mcp-servers/common/src/journal.js';
import type { Approval, Checkpoint, Deps } from '../src/types.js';
let db: Awaited<ReturnType<typeof database>>;
beforeAll(async () => { db = await database(); });
afterAll(async () => { await db?.client.end(); await db?.container.stop(); });
const task = { tenantId: 'tenant-a', input: 'synthetic trusted instruction', model: 'fixture', capabilities: ['search', 'fixture.post_message', 'http_fetch'] };
const call = (name: string, args: unknown) => ({ toolCalls: [{ id: randomUUID(), name, args }] });
const search = defineTool({ name: 'search', schema: z.object({}).strict(), sideEffect: false, async run() { return { text: 'SYNTHETIC injection', tainted: false }; } });
const schema = z.object({ text: z.string() }).strict();
test('runtime enforces capability before human approval and never accesses denied HTTP URL', async () => {
  let hits = 0; const server = createServer((_req, res) => { hits++; res.end('fixture'); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error();
  try {
    const http = createHttpFetchTool([{ scheme: 'http:', host: 'fixture.test', port: address.port, path: '/allowed', fixtureAddresses: ['127.0.0.1'] }], async () => [{ address: '127.0.0.1', family: 4 }]);
    const args = { url: `http://fixture.test:${address.port}/denied` };
    const result = await runAgent(randomUUID(), task, { store: db.store, tools: [http], security: createGuard({ allowUntainted: ['http_fetch'], egress: [{ scheme: 'http:', host: 'fixture.test', port: address.port, path: '/allowed' }] }), model: scripted([call('http_fetch', args)]) });
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'TOOL_DENIED' }); expect(hits).toBe(0);
    const id = randomUUID(); let effects = 0;
    const tool = defineTool({ name: 'fixture.post_message', schema, sideEffect: true, async run() { effects++; } });
    const deps = { store: db.store, tools: [tool], model: scripted([call(tool.name, { text: 'x' })]), security: createGuard() };
    const approval = (await runAgent(id, task, deps)).approval!;
    expect(approval).toBeDefined();
    // Capability removal changes the fingerprint and cannot resume with the old exact approval.
    expect(await runAgent(id, { ...task, capabilities: [] }, { ...deps, approvals: [approval] })).toMatchObject({ errorCode: 'RUN_INPUT_MISMATCH' });
    expect(await runAgent(randomUUID(), { ...task, capabilities: [] }, deps)).toMatchObject({ errorCode: 'TOOL_DENIED' }); expect(effects).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('taint and exact approval persist through a fresh runtime host and cannot be laundered by JSON', async () => {
  const id = randomUUID(); let effects = 0;
  const post = defineTool({ name: 'fixture.post_message', schema, sideEffect: true, async run() { effects++; return 'posted'; } });
  const options = { allowUntainted: ['fixture.post_message'], plan: ['search', 'fixture.post_message'] };
  const deps: Deps = { store: db.store, tools: [search, post], security: createGuard(options), model: scripted([call('search', {}), call(post.name, { text: '{"tainted":false,"rewritten":"synthetic"}' }), { text: 'done' }]) };
  const first = await runAgent(id, task, deps); expect(first.status).toBe('NEEDS_APPROVAL'); expect(effects).toBe(0);
  const row = await db.client.query('SELECT budget_json FROM runs WHERE id=$1', [id]);
  const state = row.rows[0].budget_json as Checkpoint;
  expect(state.security).toMatchObject({ observed: true, plan: ['fixture.post_message', 'search'] });
  const altered: Approval = { ...first.approval!, argsHash: 'b'.repeat(64) };
  expect(await runAgent(id, task, { ...deps, security: createGuard(options), approvals: [altered] })).toMatchObject({ status: 'NEEDS_APPROVAL' });
  expect(await runAgent(id, task, { ...deps, security: createGuard({ ...options, plan: [...options.plan, 'http_fetch'] }) })).toMatchObject({ errorCode: 'RUN_INPUT_MISMATCH' });
  expect(await runAgent(id, task, { ...deps, security: createGuard(options), approvals: [first.approval!], model: scripted([{ text: 'done' }]) })).toMatchObject({ status: 'DONE' });
  expect(effects).toBe(1);
});
test('frozen plans deny newly selected tools and missing legacy security state is rejected', async () => {
  let effects = 0; const post = defineTool({ name: 'fixture.post_message', schema, sideEffect: true, async run() { effects++; } });
  const options = { plan: ['search'], allowUntainted: [post.name] };
  const result = await runAgent(randomUUID(), task, { store: db.store, tools: [search, post], security: createGuard(options), model: scripted([call('search', {}), call(post.name, { text: 'after injection' })]) });
  expect(result).toMatchObject({ errorCode: 'TOOL_DENIED' }); expect(effects).toBe(0);
  const id = randomUUID(); const deps = { store: db.store, tools: [post], security: createGuard(), model: scripted([call(post.name, { text: 'x' })]) };
  expect((await runAgent(id, task, deps)).status).toBe('NEEDS_APPROVAL');
  await db.client.query("UPDATE runs SET budget_json=budget_json - 'security' WHERE id=$1", [id]);
  expect(await runAgent(id, task, deps)).toMatchObject({ errorCode: 'RUN_INPUT_MISMATCH' });
});
test('UNKNOWN reconciliation is reauthorized and never repeats the ambiguous write', async () => {
  const id = randomUUID(); let effects = 0; let lookups = 0;
  const post = defineTool({ name: 'fixture.post_message', schema, sideEffect: true, async run() { effects++; throw Error('private synthetic body'); }, async lookup() { lookups++; return 'done'; } });
  const deps = { store: db.store, tools: [post], security: createGuard(), model: scripted([call(post.name, { text: 'x' })]) };
  const approved = (await runAgent(id, task, deps)).approval!;
  expect(await runAgent(id, task, { ...deps, approvals: [approved] })).toMatchObject({ errorCode: 'ACTION_UNKNOWN' });
  expect(await runAgent(id, task, deps)).toMatchObject({ errorCode: 'APPROVAL_REQUIRED' }); expect(lookups).toBe(0);
  expect(await runAgent(id, task, { ...deps, approvals: [approved], model: scripted([{ text: 'done' }]) })).toMatchObject({ status: 'DONE' });
  expect(effects).toBe(1); expect(lookups).toBe(1);
});
test('actual runtime MCP policy authorization is distinct from human and default writes stay gated', async () => {
  const mdb = await mcpDatabase(); const key = randomBytes(32); let effects = 0;
  const journal = new ActionJournal(mdb.pool, mdb.cipher);
  const server = await startServer({ name: 'fixture', port: 0, auth: authConfig, approvalKey: key, journal, tools: [{ name: 'post_message', schema, scopes: [], write: true, async execute() { effects++; return { id: 'fixture' }; } }] });
  try {
    const tool = createRuntimeTool({ tenantId: task.tenantId, service: 'fixture', spec: { name: 'post_message', schema, write: true }, url: server.url, token: async () => jwt(server.url), authority: new ApprovalAuthority(key, server.url), approvals: () => [] });
    const args = { text: 'trusted initial action' };
    expect(await runAgent(randomUUID(), task, { store: db.store, tools: [tool], model: scripted([call(tool.name, args)]), security: createGuard() })).toMatchObject({ status: 'NEEDS_APPROVAL' }); expect(effects).toBe(0);
    expect(await runAgent(randomUUID(), { ...task, capabilities: ['search'] }, { store: db.store, tools: [tool], model: scripted([call(tool.name, args)]), security: createGuard({ allowUntainted: [tool.name] }) })).toMatchObject({ errorCode: 'TOOL_DENIED' });
    const waitingId = randomUUID();
    const waitingDeps = { store: db.store, tools: [search, tool], model: scripted([call('search', {}), call(tool.name, args)]), security: createGuard({ allowUntainted: [tool.name], plan: ['search', tool.name] }) };
    const waiting = await runAgent(waitingId, task, waitingDeps);
    expect(waiting).toMatchObject({ status: 'NEEDS_APPROVAL' }); expect(effects).toBe(0);
    expect(await runAgent(waitingId, task, { ...waitingDeps, security: createGuard({ allowUntainted: [tool.name], plan: ['search', tool.name, 'http_fetch'] }) })).toMatchObject({ errorCode: 'RUN_INPUT_MISMATCH' });
    const id = randomUUID(); const security = createGuard({ allowUntainted: [tool.name] });
    expect(await runAgent(id, task, { store: db.store, tools: [tool], model: scripted([call(tool.name, args), { text: 'done' }]), security })).toMatchObject({ status: 'DONE' }); expect(effects).toBe(1);
    const records = await mdb.pool.query('SELECT action_key FROM mcp_actions');
    const record = await journal.read(task.tenantId, records.rows[0].action_key);
    expect(record?.authorization).toEqual({ source: 'policy', policyHash: security.policyHash });
    const authority = new ApprovalAuthority(key, server.url);
    await expect(authority.issue(record!.binding, args, [], undefined, { source: 'policy', policyHash: security.policyHash })).rejects.toThrow('APPROVAL_REQUIRED');
    const proof = await authority.issue(record!.binding, args, [record!.binding]);
    expect(authority.verifyAuthorization(proof, task.tenantId, tool.name, args).authorization).toEqual({ source: 'human' });
    for (const [tenant, name, data] of [['tenant-b', tool.name, args], [task.tenantId, 'fixture.create_issue', args], [task.tenantId, tool.name, { text: 'changed' }]] as const) expect(() => authority.verify(proof, tenant, name, data)).toThrow('APPROVAL_REQUIRED');
  } finally { await server.close(); await mdb.close(); }
});

test('durable taint survives an actual child-process exit and exact approval resumes once', async () => {
  const id = randomUUID();
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./guard-worker.ts', import.meta.url).pathname], { env: { ...process.env, TEST_DATABASE_URL: db.url, TEST_RUN_ID: id }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const [code] = await once(child, 'exit'); clearTimeout(timeout);
  expect(code).toBe(0); expect(errors).toBe('');
  const first = JSON.parse(output) as { status: string; approval: Approval };
  expect(first.status).toBe('NEEDS_APPROVAL');
  let effects = 0;
  const post = defineTool({ name: 'fixture.post_message', schema, sideEffect: true, async run() { effects++; return 'posted'; } });
  const security = createGuard({ allowUntainted: [post.name], plan: ['search', post.name] });
  const deps = { store: db.store, tools: [search, post], security, model: scripted([{ text: 'done' }]) };
  expect(await runAgent(id, task, deps)).toMatchObject({ status: 'NEEDS_APPROVAL' }); expect(effects).toBe(0);
  expect(await runAgent(id, task, { ...deps, approvals: [first.approval] })).toMatchObject({ status: 'DONE' });
  expect(await runAgent(id, task, { ...deps, approvals: [first.approval] })).toMatchObject({ status: 'DONE' }); expect(effects).toBe(1);
});
