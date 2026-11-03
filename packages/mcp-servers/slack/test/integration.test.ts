import { beforeAll, afterAll, beforeEach, expect, test } from 'vitest';
import { randomBytes, createHmac } from 'node:crypto';
import { hash } from 'runtime/actions';
import { startServer } from 'mcp-common/server';
import { ActionJournal } from 'mcp-common/journal';
import { ApprovalAuthority } from 'mcp-common/approval';
import { slackTools } from '../src/index.js';
import { verifySlackWebhook } from '../src/webhook.js';
import { authConfig, client, consent, database, fixture, jwt, oauth } from '../../common/test/helpers.js';
let db: Awaited<ReturnType<typeof database>>;
let provider: Awaited<ReturnType<typeof fixture>>;
let server: Awaited<ReturnType<typeof startServer>>;
let service: ReturnType<typeof oauth>;
let authority: ApprovalAuthority;
let authReads = 0;
let scopes = 'chat:write,search:read';
let mode = 'ok';
let writes = 0;
let reads = 0;
let refreshes = 0;
let rejected = 0;
let messages: Record<string, unknown>[] = [];
const seen: string[] = [];
const key = randomBytes(32);
beforeAll(async () => {
  db = await database();
  provider = await fixture((req, res, raw) => {
    const path = new URL(req.url!, 'http://fixture').pathname;
    const params = new URLSearchParams(raw.toString());
    if (path === '/token') {
      const refreshing = params.get('grant_type') === 'refresh_token';
      if (refreshing)
        refreshes++;
      const group = {
        access_token: refreshing ? 'slack-refreshed' : 'slack-original',
        refresh_token: refreshing ? 'refresh-2' : 'refresh-1',
        expires_in: 3600,
        scope: mode === 'reduced' && refreshing ? 'chat:write' : scopes,
        token_type: 'user'
      };
      res.end(JSON.stringify(refreshing ? {
        ok: true, ...group
      } : {
        ok: true, authed_user: group
      }));
      return;
    }
    if (path === '/auth.test') {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end('{}');
        return;
      }
      authReads++;
      if (mode === 'writer401' && authReads === 2) {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      res.end(JSON.stringify({
        ok: true, user_id: 'U123', team_id: 'T123'
      }));
      return;
    }
    seen.push(req.headers.authorization ?? '');
    if (mode === 'unauthorized' || mode === 'reduced') {
      if (req.headers.authorization === 'Bearer slack-original') {
        rejected++;
        res.statusCode = 401;
        res.end('{}');
        return;
      }
    }
    if (mode === 'always401') {
      rejected++;
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    if (path === '/search.messages') {
      reads++;
      if (mode === 'lookup-error') {
        res.statusCode = 503;
        res.end('{"error":"provider secret PII"}');
        return;
      }
      res.end(JSON.stringify({
        ok: true, messages: {
          matches: messages.length ? messages : [{
              text: 'fixture hit', channel: {
                id: 'C123'
              }, ts: '1.0'
            }], paging: {
            page: 1, pages: 1, total: 1
          }
        }
      }));
      return;
    }
    if (path === '/chat.postMessage') {
      writes++;
      const body = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push({
        text: body.text, channel: {
          id: body.channel
        }, ts: '123.456', user: 'U123'
      });
      if (mode === 'lost') {
        req.socket.destroy();
        return;
      }
      res.end(JSON.stringify({
        ok: true, channel: body.channel, ts: '123.456'
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  service = oauth(db, provider.origin);
  server = await startServer({
    name: 'slack', port: 0, auth: authConfig, approvalKey: key, journal: new ActionJournal(db.pool, db.cipher), tools: slackTools(service, {
      apiBase: provider.origin, timeoutMs: 300
    }), webhook: (raw, headers) => verifySlackWebhook(raw, headers.get('x-slack-request-timestamp') ?? '', headers.get('x-slack-signature') ?? '', 'fixture-signing')
  });
  authority = new ApprovalAuthority(key, server.url);
});
afterAll(async () => {
  await server?.close();
  await provider?.close();
  await db?.close();
  expect(provider?.failures).toEqual([]);
});
beforeEach(async () => {
  scopes = 'chat:write,search:read';
  mode = 'ok';
  authReads = 0;
  writes = reads = refreshes = rejected = 0;
  messages = [];
  seen.length = 0;
  await db.pool.query('DELETE FROM mcp_actions');
  await consent(service);
});
async function proof(args: Record<string, unknown>, tenant = 'tenant-a') {
  const binding = {
    tenantId: tenant, runId: '10000000-0000-4000-8000-000000000001', tool: 'slack.post_message', actionKey: 'a'.repeat(64), argsHash: hash(args)
  };
  return authority.issue(binding, args, [binding], async () => 'allow');
}
// Omitting provider snapshots or enforcing requested instead of actual scopes exposes unauthorized tool results.
test('toolDeniedWhenScopeMissing', async () => {
  scopes = 'chat:write';
  await consent(service);
  const c = await client(server.url);
  try {
    const tools = await c.listTools();
    expect(tools.tools.map(t => t.name)).toEqual(['post_message', 'search_messages']);
    expect(tools.tools.find(t => t.name === 'search_messages')?._meta).toMatchObject({
      requiredScopes: ['search:read']
    });
    expect(await c.callTool({
      name: 'search_messages', arguments: {
        query: 'fixture'
      }
    })).toMatchObject({
      isError: true, content: [{
          text: 'SCOPE_MISSING'
        }]
    });
    expect(reads).toBe(0);
  }
  finally {
    await c.close();
  }
});
test('SDK search uses actual Task5 user token and performs one refresh after 401', async () => {
  mode = 'unauthorized';
  const c = await client(server.url);
  try {
    const r = await c.callTool({
      name: 'search_messages', arguments: {
        query: 'fixture'
      }
    });
    expect(r.isError).not.toBe(true);
    expect(JSON.stringify(r)).toContain('fixture hit');
    expect(seen).toEqual(['Bearer slack-original', 'Bearer slack-refreshed']);
    expect(refreshes).toBe(1);
  }
  finally {
    await c.close();
  }
});
test('rechecks reduced scopes and bounds repeated unauthorized resource responses', async () => {
  const c = await client(server.url);
  try {
    mode = 'reduced';
    expect((await c.callTool({
      name: 'search_messages', arguments: {
        query: 'fixture'
      }
    })).isError).toBe(true);
    expect(reads).toBe(0);
    expect(rejected).toBe(1);
    mode = 'always401';
    await consent(service);
    expect((await c.callTool({
      name: 'search_messages', arguments: {
        query: 'fixture'
      }
    })).isError).toBe(true);
    expect(rejected).toBe(3);
  }
  finally {
    await c.close();
  }
});
// Without server-verified proof, model arguments or another principal can write.
test('writes require exact host approval and duplicate calls have one provider effect', async () => {
  const args = {
    channel: 'C123', text: 'fixture-only'
  };
  const c = await client(server.url);
  const b = await client(server.url, jwt(server.url, {
    sub: 'subject-b'
  }));
  try {
    expect((await c.callTool({
      name: 'post_message', arguments: args, _meta: {
        approved: true
      }
    })).isError).toBe(true);
    const permit = await proof(args);
    expect((await b.callTool({
      name: 'post_message', arguments: args, _meta: {
        'keel/approval': permit
      }
    })).isError).toBe(true);
    expect(writes).toBe(0);
    const results = await Promise.all([1, 2].map(() => c.callTool({
      name: 'post_message', arguments: args, _meta: {
        'keel/approval': permit
      }
    })));
    expect(results.some(r => !r.isError)).toBe(true);
    expect(writes).toBe(1);
    expect(messages[0]?.text).toBe('fixture-only\n[keel-action:' + 'a'.repeat(64) + ']');
    expect((await c.callTool({
      name: 'post_message', arguments: {
        ...args, text: 'changed'
      }, _meta: {
        'keel/approval': permit
      }
    })).isError).toBe(true);
    expect(writes).toBe(1);
  }
  finally {
    await c.close();
    await b.close();
  }
});
// Losing the HTTP result must trigger provider reconciliation instead of another write, even after journal recreation.
test('lost write reply reconciles by marker and lookup failures never authorize retry', async () => {
  const args = {
    channel: 'C123', text: 'fixture-only'
  };
  const c = await client(server.url);
  try {
    mode = 'lost';
    expect((await c.callTool({
      name: 'post_message', arguments: args, _meta: {
        'keel/approval': await proof(args)
      }
    })).isError).toBe(true);
    expect(writes).toBe(1);
    mode = 'lookup-error';
    const lookup = () => fetch(server.origin + '/actions/lookup', {
      method: 'POST', headers: {
        Authorization: `Bearer ${jwt(server.url)}`, 'content-type': 'application/json'
      }, body: JSON.stringify({
        actionKey: 'a'.repeat(64)
      })
    });
    expect((await lookup()).status).toBe(409);
    expect(writes).toBe(1);
    mode = 'ok';
    expect(await (await lookup()).json()).toEqual({
      status: 'done'
    });
    expect(writes).toBe(1);
  }
  finally {
    await c.close();
  }
});
test('webhook verifies raw bytes before parsing and duplicate deliveries produce no writes', async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = '{ "type":"event_callback", "event":{"text":"fixture"}}';
  const signature = 'v0=' + createHmac('sha256', 'fixture-signing').update(`v0:${timestamp}:${body}`).digest('hex');
  const headers = {
    'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature
  };
  expect((await fetch(server.origin + '/webhook', {
    method: 'POST', headers, body: body + ' '
  })).status).toBe(401);
  for (let n = 0; n < 2; n++)
    expect((await fetch(server.origin + '/webhook', {
      method: 'POST', headers, body
    })).status).toBe(200);
  expect(writes).toBe(0);
});
// Removing the bridge's host-only approval check or treating a failed lookup as absent duplicates the fixture write.
test('actual runtime resumes UNKNOWN through Tool.lookup across new bridge instances', async () => {
  const { runAgent } = await import('runtime/loop');
  const { PostgresStore } = await import('runtime/store');
  const { createRuntimeTool } = await import('mcp-common/bridge');
  const approvals: import('runtime/types').Approval[] = [];
  const args = {
    channel: 'C123', text: 'runtime fixture'
  };
  const model: Parameters<typeof runAgent>[2]['model'] = {
    async *stream(request) {
      if (request.messages.some(m => m.role === 'tool'))
        yield {
          text: 'done'
        };
      else
        yield {
          toolCalls: [{
              id: 'fixture-call', name: 'slack.post_message', args
            }]
        };
    }
  };
  const tool = () => createRuntimeTool({
    tenantId: 'tenant-a', service: 'slack', spec: slackTools(service, {
      apiBase: provider.origin, timeoutMs: 300
    })[0]!, url: server.url, token: async () => jwt(server.url), authority, approvals: () => approvals, guard: async () => 'allow'
  });
  const runId = '20000000-0000-4000-8000-000000000002';
  const task = {
    tenantId: 'tenant-a', input: 'fixture-only', model: 'fixture', capabilities: []
  };
  const store = new PostgresStore(db.connectionString);
  const deps = () => ({
    store, model, tools: [tool()], approvals, guard: async () => 'allow' as const
  });
  const first = await runAgent(runId, task, deps());
  expect(first.status).toBe('NEEDS_APPROVAL');
  expect(writes).toBe(0);
  expect(first.approval).toBeDefined();
  approvals.push(first.approval!);
  mode = 'lost';
  expect(await runAgent(runId, task, deps())).toMatchObject({
    status: 'NEEDS_APPROVAL', errorCode: 'ACTION_UNKNOWN'
  });
  expect(writes).toBe(1);
  mode = 'lookup-error';
  expect(await runAgent(runId, task, deps())).toMatchObject({
    status: 'NEEDS_APPROVAL', errorCode: 'ACTION_UNKNOWN'
  });
  expect(writes).toBe(1);
  mode = 'ok';
  expect(await runAgent(runId, task, deps())).toMatchObject({
    status: 'DONE', output: 'done'
  });
  expect(writes).toBe(1);
  expect((await db.pool.query('SELECT status FROM actions WHERE action_key=$1', [first.approval!.actionKey])).rows).toEqual([{
      status: 'SUCCEEDED'
    }]);
});
// A visible marker copied by another writer, wrong destination, or duplicate matches is not reliable reconciliation evidence.
test('Slack lookup rejects forged mismatched and ambiguous marker results and isolates tenants', async () => {
  const args = {
    channel: 'C123', text: 'fixture-only'
  };
  const c = await client(server.url);
  try {
    mode = 'lost';
    await c.callTool({
      name: 'post_message', arguments: args, _meta: {
        'keel/approval': await proof(args)
      }
    });
    expect(messages).toHaveLength(1);
    mode = 'ok';
    const original = structuredClone(messages[0]!);
    const lookup = (sub = 'subject-a') => fetch(server.origin + '/actions/lookup', {
      method: 'POST', headers: {
        Authorization: `Bearer ${jwt(server.url, {
          sub
        })}`
      }, body: JSON.stringify({
        actionKey: 'a'.repeat(64)
      })
    });
    expect(await (await lookup('subject-b')).json()).toEqual({
      status: 'absent'
    });
    for (const bad of [{
        ...original, user: 'UOTHER'
      }, {
        ...original, channel: {
          id: 'COTHER'
        }
      }, {
        ...original, text: 'changed'
      }]) {
      messages = [bad];
      expect((await lookup()).status).toBe(409);
    }
    messages = [original, original];
    expect((await lookup()).status).toBe(409);
    messages = [];
    expect((await lookup()).status).toBe(409);
    messages = [original];
    expect(await (await lookup()).json()).toEqual({
      status: 'done'
    });
    expect(writes).toBe(1);
  }
  finally {
    await c.close();
  }
});
// SDK JSON Schema conversion must retain strict field validation before any vendor request.
test('SDK rejects model-supplied approval fields and malformed tool arguments before provider traffic', async () => {
  const c = await client(server.url);
  try {
    for (const args of [{
        channel: 'C123', text: 'fixture', approved: true
      }, {
        channel: '../escape', text: 'fixture'
      }, {
        channel: 'C123', text: 12
      }]) {
      let denied = false;
      try {
        denied = (await c.callTool({
          name: 'post_message', arguments: args
        })).isError === true;
      }
      catch {
        denied = true;
      }
      expect(denied).toBe(true);
    }
    expect(writes).toBe(0);
    expect(reads).toBe(0);
  }
  finally {
    await c.close();
  }
});
// Expiry between writer preparation and dispatch must use the rejected-token refresh port too.
test('refreshes a 401 during writer revalidation before dispatch without duplicating the write', async () => {
  const args = {
    channel: 'C123', text: 'fixture-only'
  };
  const c = await client(server.url);
  try {
    mode = 'writer401';
    const result = await c.callTool({
      name: 'post_message', arguments: args, _meta: {
        'keel/approval': await proof(args)
      }
    });
    expect(result.isError).not.toBe(true);
    expect(refreshes).toBe(1);
    expect(writes).toBe(1);
    expect(seen).toEqual(['Bearer slack-refreshed']);
  }
  finally {
    await c.close();
  }
});
// Official auth.test is POST; a permissive fixture must not hide a wrong wire method.
test('writer identity uses the documented auth.test POST method', async () => {
  const args = {
    channel: 'C123', text: 'fixture-only'
  };
  const c = await client(server.url);
  try {
    expect((await c.callTool({
      name: 'post_message', arguments: args, _meta: {
        'keel/approval': await proof(args)
      }
    })).isError).not.toBe(true);
    expect(writes).toBe(1);
    expect(authReads).toBe(2);
  }
  finally {
    await c.close();
  }
});
