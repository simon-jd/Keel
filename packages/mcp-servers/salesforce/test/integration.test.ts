import { beforeAll, afterAll, beforeEach, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { OAuthService, PostgresTokenStore, salesforce } from 'oauth';
import { startServer } from 'mcp-common/server';
import { ActionJournal } from 'mcp-common/journal';
import { ApprovalAuthority } from 'mcp-common/approval';
import { createRuntimeTool } from 'mcp-common/bridge';
import { runAgent } from 'runtime/loop';
import { PostgresStore } from 'runtime/store';
import type { Approval } from 'runtime/types';
import { salesforceTools } from '../src/index.js';
import { authConfig, client, database, fixture, jwt } from '../../common/test/helpers.js';
let db: Awaited<ReturnType<typeof database>>, provider: Awaited<ReturnType<typeof fixture>>, server: Awaited<ReturnType<typeof startServer>>;
let oauth: OAuthService, authority: ApprovalAuthority;
let scopes = ['api', 'id'], mode = '', queries = 0, writes = 0, refreshes = 0, identities = 0;
const consents: unknown[] = [];
const key = randomBytes(32);
const args = {
    case_id: '500000000000001AAA', status: 'Closed'
};
const config = () => ({
    tenants: {
        'tenant-a': {
            instanceUrl: provider.origin, objects: ['Case', 'Account'], caseStatuses: ['New', 'Closed']
        }
    }, apiVersion: 'v66.0', timeoutMs: 1000, onConsentRequired: async (request: unknown) => {
        consents.push(request);
    }
});
async function grant() {
    const p = await oauth.start('salesforce', 'tenant-a', scopes);
    await oauth.callback('fixture', p.state);
}
beforeAll(async () => {
    db = await database();
    provider = await fixture((req, res, raw) => {
        const url = new URL(req.url!, 'http://fixture');
        if (url.pathname === '/token') {
            const refresh = new URLSearchParams(raw.toString()).get('grant_type') === 'refresh_token';
            if (refresh)
                refreshes++;
            res.end(JSON.stringify({
                access_token: refresh ? 'sf-new' : 'sf-old', refresh_token: 'refresh', scope: (refresh && mode === 'reduced' ? [] : scopes).join(' '), token_type: 'Bearer', instance_url: provider?.origin
            }));
            return;
        }
        expect(req.headers.authorization).toMatch(/^Bearer sf-(old|new)$/);
        if (mode === 'reduced' && req.headers.authorization === 'Bearer sf-old') {
            res.statusCode = 401;
            res.end('{}');
            return;
        }
        if (url.pathname === '/services/oauth2/userinfo') {
            identities++;
            if (mode === 'identity204' && identities > 1) {
                res.statusCode = 204;
                res.end();
                return;
            }
            res.end(JSON.stringify({
                user_id: mode === 'changedWriter' && identities > 1 ? '005000000000002AAA' : '005000000000001AAA', organization_id: '00D000000000001AAA'
            }));
            return;
        }
        if (url.pathname.includes('/query')) {
            queries++;
            if (mode === '429' && queries === 1) {
                res.statusCode = 429;
                res.setHeader('Retry-After', '0');
                res.end('{}');
                return;
            }
            if (url.pathname.endsWith('/query'))
                res.end(JSON.stringify({
                    done: false, records: [{
                            Id: 'a1'
                        }], nextRecordsUrl: mode === 'escape' ? 'https://attacker.example/services/data/v66.0/query/x' : mode === 'pathescape' ? '/services/data/v66.0/sobjects/User' : '/services/data/v66.0/query/locator-1'
                }));
            else
                res.end(JSON.stringify({
                    done: true, records: [{
                            Id: 'a2'
                        }]
                }));
            return;
        }
        if (url.pathname === '/services/data/v66.0/sobjects/Case/' + args.case_id) {
            if (req.method === 'PATCH') {
                expect(JSON.parse(raw.toString())).toEqual({
                    Status: 'Closed'
                });
                writes++;
                if (mode === 'lost') {
                    req.socket.destroy();
                    return;
                }
                if (mode === 'badSuccess') {
                    res.end('null');
                    return;
                }
                res.statusCode = 204;
                res.end();
                return;
            }
            res.end(JSON.stringify({
                Id: args.case_id, Status: 'Closed'
            }));
            return;
        }
        throw Error('Unexpected provider endpoint');
    });
    oauth = new OAuthService(new PostgresTokenStore(db.pool, db.cipher, {
        timeoutMs: 1000
    }), [salesforce({
            clientId: 'fixture-sf', redirectUri: 'http://127.0.0.1/callback', loginOrigin: 'https://test.salesforce.com', endpoints: {
                authorize: provider.origin + '/authorize', token: provider.origin + '/token', revoke: provider.origin + '/revoke'
            }
        })]);
    server = await startServer({
        name: 'salesforce', port: 0, auth: authConfig, approvalKey: key, journal: new ActionJournal(db.pool, db.cipher), tools: salesforceTools(oauth, config())
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
    mode = '';
    scopes = ['api', 'id'];
    queries = writes = refreshes = identities = 0;
    consents.length = 0;
    await db.pool.query('DELETE FROM mcp_actions');
    await grant();
});
async function query(soql: string) {
    const c = await client(server.url);
    try {
        return await c.callTool({
            name: 'query', arguments: {
                soql
            }
        });
    }
    finally {
        await c.close();
    }
}
test('salesforceSOQLAllowlist rejects nested relationships and unsupported grammar before HTTP', async () => {
    for (const q of ['SELECT Id FROM User', 'SELECT Id,(SELECT Id FROM Contacts) FROM Account', 'SELECT Owner.Name FROM Case', 'SELECT Id FROM Case WHERE Owner.Name = \'x\'', 'SELECT TYPEOF Owner WHEN User THEN Name END FROM Case', 'SELECT Id FROM Case WHERE Id IN (SELECT Id FROM User)', 'SELECT Id FROM Case FOR UPDATE', 'SELECT Id FROM Case; DELETE FROM Case', 'SELECT FIELDS(ALL) FROM Case'])
        expect((await query(q)).isError).toBe(true);
    expect(queries).toBe(0);
    const result = await query("SELECT Id, Status FROM Case WHERE Status = 'New' ORDER BY Id LIMIT 10");
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('a2');
    expect(queries).toBe(2);
});
test.each(["'New'", 'TRUE', 'FALSE', 'NULL'])('SOQL unary minus rejects nonnumeric literal %s before provider HTTP', async (literal) => {
    const result = await query(`SELECT Id FROM Case WHERE Status = -${literal}`);
    expect(result.isError).toBe(true);
    expect(queries).toBe(0);
});
test('SOQL unary minus preserves numeric literals through provider HTTP', async () => {
    for (const literal of ['-1', '-0.25']) {
        const result = await query(`SELECT Id FROM Case WHERE Priority__c >= ${literal}`);
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).toContain('a2');
    }
    expect(queries).toBe(4);
});
test('backoffOn429 and pagination stays on trusted instance and query path', async () => {
    mode = '429';
    expect((await query('SELECT Id FROM Account')).isError).not.toBe(true);
    expect(queries).toBe(3);
    for (const m of ['escape', 'pathescape']) {
        mode = m;
        queries = 0;
        expect((await query('SELECT Id FROM Account')).isError).toBe(true);
        expect(queries).toBe(1);
    }
});
test('incrementalScopeRequestedOnlyWhenNeeded and actual reduced grants fail closed', async () => {
    expect(consents).toEqual([]);
    scopes = [];
    await grant();
    expect((await query('SELECT Id FROM Case')).isError).toBe(true);
    expect(queries).toBe(0);
    expect(consents).toHaveLength(1);
    scopes = ['api'];
    await grant();
    mode = 'reduced';
    expect((await query('SELECT Id FROM Case')).isError).toBe(true);
    expect(queries).toBe(0);
    expect(refreshes).toBe(1);
});
test.each(['ok', 'lost'])('runtime approval and durable unknown never repeat Case PATCH (%s)', async (outcome) => {
    const approvals: Approval[] = [];
    const store = new PostgresStore(db.connectionString);
    const model: Parameters<typeof runAgent>[2]['model'] = {
        async *stream(request) {
            if (request.messages.some(m => m.role === 'tool'))
                yield {
                    text: 'done'
                };
            else
                yield {
                    toolCalls: [{
                            id: 'fixture-call', name: 'salesforce.update_case_status', args
                        }]
                };
        }
    };
    const tool = () => createRuntimeTool({
        tenantId: 'tenant-a', service: 'salesforce', spec: salesforceTools(oauth, config())[1]!, url: server.url, token: async () => jwt(server.url), authority, approvals: () => approvals, guard: async () => 'allow'
    });
    const deps = () => ({
        store, model, tools: [tool()], approvals, guard: async () => 'allow' as const
    });
    const task = {
        tenantId: 'tenant-a', input: 'synthetic case', model: 'fixture', capabilities: []
    };
    const runId = outcome === 'ok' ? '40000000-0000-4000-8000-000000000001' : '40000000-0000-4000-8000-000000000002';
    const first = await runAgent(runId, task, deps());
    expect(first.status).toBe('NEEDS_APPROVAL');
    expect(writes).toBe(0);
    approvals.push(first.approval!);
    mode = outcome;
    expect((await runAgent(runId, task, deps())).status).toBe(outcome === 'ok' ? 'DONE' : 'NEEDS_APPROVAL');
    expect(writes).toBe(1);
    mode = '';
    expect((await runAgent(runId, task, deps())).status).toBe(outcome === 'ok' ? 'DONE' : 'NEEDS_APPROVAL');
    expect(writes).toBe(1);
});
// The persisted dispatch evidence must identify the original CRM writer before any effect.
test('changed Salesforce writer between preparation and dispatch causes no PATCH', async () => {
    const { hash } = await import('runtime/actions');
    const c = await client(server.url);
    try {
        mode = 'changedWriter';
        const binding = {
            tenantId: 'tenant-a', runId: '50000000-0000-4000-8000-000000000001', tool: 'salesforce.update_case_status', actionKey: 'c'.repeat(64), argsHash: hash(args)
        };
        const permit = await authority.issue(binding, args, [binding], async () => 'allow');
        expect((await c.callTool({
            name: 'update_case_status', arguments: args, _meta: {
                'keel/approval': permit
            }
        })).isError).toBe(true);
        expect(writes).toBe(0);
    }
    finally {
        await c.close();
    }
});
test('write status and tenant boundaries reject before PATCH', async () => {
    const { hash } = await import('runtime/actions');
    const c = await client(server.url);
    const other = await client(server.url, jwt(server.url, {
        sub: 'subject-b'
    }));
    try {
        expect((await c.callTool({
            name: 'update_case_status', arguments: args, _meta: {
                approved: true
            }
        })).isError).toBe(true);
        const bad = {
            ...args, status: 'Unconfigured'
        };
        const binding = {
            tenantId: 'tenant-a', runId: '50000000-0000-4000-8000-000000000002', tool: 'salesforce.update_case_status', actionKey: 'b'.repeat(64), argsHash: hash(bad)
        };
        const permit = await authority.issue(binding, bad, [binding], async () => 'allow');
        expect((await c.callTool({
            name: 'update_case_status', arguments: bad, _meta: {
                'keel/approval': permit
            }
        })).isError).toBe(true);
        expect((await other.callTool({
            name: 'query', arguments: {
                soql: 'SELECT Id FROM Case'
            }
        })).isError).toBe(true);
        expect(writes).toBe(0);
        expect(queries).toBe(0);
    }
    finally {
        await c.close();
        await other.close();
    }
});
test('unexpected PATCH success status is not treated as documented 204 acknowledgement', async () => {
    const { hash } = await import('runtime/actions');
    const c = await client(server.url);
    mode = 'badSuccess';
    try {
        const binding = {
            tenantId: 'tenant-a', runId: '50000000-0000-4000-8000-000000000003', tool: 'salesforce.update_case_status', actionKey: 'd'.repeat(64), argsHash: hash(args)
        };
        const permit = await authority.issue(binding, args, [binding], async () => 'allow');
        expect((await c.callTool({
            name: 'update_case_status', arguments: args, _meta: {
                'keel/approval': permit
            }
        })).isError).toBe(true);
        expect(writes).toBe(1);
    }
    finally {
        await c.close();
    }
});
test('identity revalidation 204 cannot masquerade as successful Case PATCH', async () => {
    const { hash } = await import('runtime/actions');
    const c = await client(server.url);
    mode = 'identity204';
    try {
        const binding = {
            tenantId: 'tenant-a', runId: '50000000-0000-4000-8000-000000000004', tool: 'salesforce.update_case_status', actionKey: 'e'.repeat(64), argsHash: hash(args)
        };
        const permit = await authority.issue(binding, args, [binding], async () => 'allow');
        expect((await c.callTool({
            name: 'update_case_status', arguments: args, _meta: {
                'keel/approval': permit
            }
        })).isError).toBe(true);
        expect(writes).toBe(0);
    }
    finally {
        await c.close();
    }
});
