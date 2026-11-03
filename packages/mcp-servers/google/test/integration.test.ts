import { beforeAll, afterAll, beforeEach, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { OAuthService, PostgresTokenStore, google } from 'oauth';
import { startServer } from 'mcp-common/server';
import { ActionJournal } from 'mcp-common/journal';
import { ApprovalAuthority } from 'mcp-common/approval';
import { hash } from 'runtime/actions';
import { googleTools } from '../src/index.js';
import { authConfig, client, database, fixture, jwt } from '../../common/test/helpers.js';
const prefix = 'https://www.googleapis.com/auth/';
const allScopes = ['gmail.readonly', 'gmail.compose', 'calendar.freebusy'].map(s => prefix + s).concat('openid', 'email');
let db: Awaited<ReturnType<typeof database>>, provider: Awaited<ReturnType<typeof fixture>>, server: Awaited<ReturnType<typeof startServer>>;
let oauth: OAuthService, authority: ApprovalAuthority;
let scopes = allScopes, mode = '', writes = 0, reads = 0, refreshes = 0, identityReads = 0;
let writer = 'writer@example.test', subject = 'Fixture subject';
let drafts: {
    id: string;
    message: {
        id: string;
        threadId: string;
        raw: string;
    };
}[] = [];
const requests: {
    method: string;
    path: string;
    auth: string;
}[] = [];
const consents: unknown[] = [];
const approvalKey = randomBytes(32);
const args = {
    thread_id: 'abc123', body: 'Synthetic reply: ünicode\nsecond line'
};
async function grant(tenant = 'tenant-a') {
    const pending = await oauth.start('google', tenant, scopes);
    await oauth.callback('synthetic-code', pending.state);
}
const options = () => ({
    gmailBase: provider.origin + '/gmail/v1',
    identityUrl: provider.origin + '/userinfo', calendarBase: provider.origin + '/calendar/v3', timeoutMs: 1000, onConsentRequired: async (request: unknown) => {
        consents.push(request);
    }
});
beforeAll(async () => {
    db = await database();
    provider = await fixture((req, res, raw) => {
        const url = new URL(req.url!, 'http://fixture');
        if (url.pathname === '/token') {
            const refresh = new URLSearchParams(raw.toString()).get('grant_type') === 'refresh_token';
            if (refresh)
                refreshes++;
            res.end(JSON.stringify({
                access_token: refresh ? 'google-new' : 'google-old', refresh_token: 'refresh', expires_in: 3600, scope: (mode === 'reduced' && refresh ? [prefix + 'gmail.metadata'] : scopes).join(' ')
            }));
            return;
        }
        requests.push({
            method: req.method!, path: req.url!, auth: req.headers.authorization ?? ''
        });
        if (mode === 'reduced' && req.headers.authorization === 'Bearer google-old') {
            res.statusCode = 401;
            res.end('{}');
            return;
        }
        if (url.pathname === '/userinfo') {
            identityReads++;
            if (mode === 'identity201' && identityReads === 4) {
                res.statusCode = 201;
                res.end(JSON.stringify({
                    id: 'fake', message: {
                        id: 'fake-message', threadId: 'abc123'
                    }
                }));
                return;
            }
            res.end(JSON.stringify({
                sub: mode === 'changedSubject' ? 'different-subject' : 'original-subject', email: 'ignored-extra@example.test', name: 'Synthetic profile must not be forwarded'
            }));
            return;
        }
        if (url.pathname.endsWith('/profile')) {
            res.end(JSON.stringify({
                emailAddress: writer
            }));
            return;
        }
        if (url.pathname.endsWith('/threads/abc123')) {
            expect(url.searchParams.get('format')).toBe('metadata');
            res.end(JSON.stringify({
                id: 'abc123', messages: [{
                        id: 'm1', payload: {
                            headers: [{
                                    name: 'From', value: 'sender@example.test'
                                }, {
                                    name: 'Subject', value: subject
                                }, {
                                    name: 'Message-ID', value: '<original@example.test>'
                                }]
                        }
                    }]
            }));
            return;
        }
        if (url.pathname.endsWith('/messages')) {
            reads++;
            expect(url.searchParams.get('q')).toBe('fixture');
            if (mode === '429' && reads === 1) {
                res.statusCode = 429;
                res.setHeader('Retry-After', '0');
                res.end('{}');
                return;
            }
            res.end(JSON.stringify(url.searchParams.has('pageToken') ? {
                messages: [{
                        id: 'm2', threadId: 't2'
                    }], ...(mode === 'cycle' ? {
                    nextPageToken: 'p2'
                } : {})
            } : {
                messages: [{
                        id: 'm1', threadId: 't1'
                    }], nextPageToken: 'p2'
            }));
            return;
        }
        if (url.pathname.endsWith('/drafts') && req.method === 'POST') {
            writes++;
            const body = JSON.parse(raw.toString());
            if (mode === 'write429') {
                res.statusCode = 429;
                res.end('{}');
                return;
            }
            drafts.push({
                id: 'd1', message: {
                    id: 'dm1', ...body.message
                }
            });
            if (mode === 'lost') {
                req.socket.destroy();
                return;
            }
            res.end(JSON.stringify({
                id: 'd1', message: {
                    id: 'dm1', threadId: mode === 'wrongCreatedThread' ? 'wrong' : body.message.threadId
                }
            }));
            return;
        }
        if (url.pathname.endsWith('/drafts')) {
            res.end(JSON.stringify({
                drafts: drafts.map(d => ({
                    id: d.id, message: {
                        id: 'dm1', threadId: d.message.threadId
                    }
                }))
            }));
            return;
        }
        if (url.pathname.endsWith('/drafts/d1')) {
            expect(url.searchParams.get('format')).toBe('raw');
            res.end(JSON.stringify(drafts[0]));
            return;
        }
        if (url.pathname === '/calendar/v3/freeBusy') {
            expect(req.method).toBe('POST');
            const body = JSON.parse(raw.toString());
            expect(body.items).toEqual([{
                    id: 'a@example.test'
                }, {
                    id: 'b@example.test'
                }]);
            res.end(JSON.stringify({
                calendars: {
                    'a@example.test': {
                        busy: [{
                                start: '2026-10-25T10:00:00Z', end: '2026-10-25T10:30:00Z'
                            }]
                    }, ...(mode === 'missingCalendar' ? {} : {
                        'b@example.test': mode === 'calendarError' ? {
                            errors: [{
                                    reason: 'forbidden'
                                }]
                        } : {
                            busy: [{
                                    start: '2026-10-25T10:15:00Z', end: '2026-10-25T11:00:00Z'
                                }]
                        }
                    })
                }
            }));
            return;
        }
        throw Error('Unexpected fixture endpoint');
    });
    oauth = new OAuthService(new PostgresTokenStore(db.pool, db.cipher, {
        timeoutMs: 1000
    }), [google({
            clientId: 'fixture-google', clientType: 'desktop', redirectUri: 'http://127.0.0.1/callback', endpoints: {
                authorize: provider.origin + '/authorize', token: provider.origin + '/token', revoke: provider.origin + '/revoke'
            }
        })]);
    server = await startServer({
        name: 'google', port: 0, auth: authConfig, approvalKey, journal: new ActionJournal(db.pool, db.cipher), tools: googleTools(oauth, options())
    });
    authority = new ApprovalAuthority(approvalKey, server.url);
});
afterAll(async () => {
    await server?.close();
    await provider?.close();
    await db?.close();
    expect(provider?.failures).toEqual([]);
});
beforeEach(async () => {
    scopes = allScopes;
    mode = '';
    writes = reads = refreshes = identityReads = 0;
    drafts = [];
    requests.length = consents.length = 0;
    writer = 'writer@example.test';
    subject = 'Fixture subject';
    await db.pool.query('DELETE FROM mcp_actions');
    await grant();
});
async function call(name: string, arguments_: Record<string, unknown>, proof?: string) {
    const c = await client(server.url);
    try {
        return await c.callTool({
            name, arguments: arguments_, ...(proof ? {
                _meta: {
                    'keel/approval': proof
                }
            } : {})
        });
    }
    finally {
        await c.close();
    }
}
async function proof() {
    const b = {
        tenantId: 'tenant-a', runId: '30000000-0000-4000-8000-000000000001', tool: 'google.draft_reply', actionKey: 'a'.repeat(64), argsHash: hash(args)
    };
    return authority.issue(b, args, [b], async () => 'allow');
}
async function lookup() {
    return fetch(server.origin + '/actions/lookup', {
        method: 'POST', headers: {
            Authorization: `Bearer ${jwt(server.url)}`
        }, body: JSON.stringify({
            actionKey: 'a'.repeat(64)
        })
    });
}
test('paginatesGmailSearch', async () => {
    const result = await call('search', {
        query: 'fixture'
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('m2');
    expect(reads).toBe(2);
    expect(requests.every(r => r.auth === 'Bearer google-old')).toBe(true);
});
test('backoffOn429', async () => {
    mode = '429';
    expect((await call('search', {
        query: 'fixture'
    })).isError).not.toBe(true);
    expect(reads).toBe(3);
});
test('incrementalScopeRequestedOnlyWhenNeeded', async () => {
    expect(consents).toEqual([]);
    expect((await call('search', {
        query: 'fixture'
    })).isError).not.toBe(true);
    expect(consents).toEqual([]);
    scopes = [prefix + 'gmail.metadata'];
    await grant();
    const result = await call('search', {
        query: 'fixture'
    });
    expect(result).toMatchObject({
        isError: true, content: [{
                text: 'SCOPE_MISSING'
            }], _meta: {
            requiredScopes: [prefix + 'gmail.readonly']
        }
    });
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
        tenantId: 'tenant-a', provider: 'google', scopes: [prefix + 'gmail.readonly']
    });
    expect(JSON.stringify(result)).not.toMatch(/state|authUrl|google-old|refresh/);
    expect(reads).toBe(2);
});
test('compose alone cannot read original thread and refresh reduction denies search', async () => {
    scopes = [prefix + 'gmail.compose'];
    await grant();
    expect((await call('draft_reply', args, await proof())).isError).toBe(true);
    expect(requests).toEqual([]);
    expect(writes).toBe(0);
    scopes = allScopes;
    await grant();
    mode = 'reduced';
    expect((await call('search', {
        query: 'fixture'
    })).isError).toBe(true);
    expect(refreshes).toBe(1);
    expect(reads).toBe(0);
});
test('draft requires approval, freezes safe MIME, and never sends or duplicates', async () => {
    expect((await call('draft_reply', args)).isError).toBe(true);
    expect(writes).toBe(0);
    const p = await proof();
    expect((await call('draft_reply', args, p)).isError).not.toBe(true);
    expect((await call('draft_reply', args, p)).isError).not.toBe(true);
    expect(writes).toBe(1);
    const mime = Buffer.from(drafts[0]!.message.raw, 'base64url').toString();
    expect(mime).toContain('In-Reply-To: <original@example.test>');
    expect(mime).toContain('To: sender@example.test');
    expect(mime).toContain('From: writer@example.test');
    expect(mime).toContain(Buffer.from(args.body).toString('base64'));
    expect(requests.some(r => r.path.includes('send'))).toBe(false);
});
test('lost draft reply reconciles frozen original contents and original mailbox only', async () => {
    mode = 'lost';
    expect((await call('draft_reply', args, await proof())).isError).toBe(true);
    expect(writes).toBe(1);
    mode = '';
    subject = 'Later changed thread';
    writer = 'other@example.test';
    expect((await lookup()).status).toBe(409);
    writer = 'writer@example.test';
    const original = structuredClone(drafts[0]!);
    drafts[0]!.message.raw = Buffer.from('copied marker').toString('base64url');
    expect((await lookup()).status).toBe(409);
    drafts = [original];
    expect((await lookup()).status).toBe(200);
    expect(writes).toBe(1);
});
test('fails closed on unsafe headers, cyclic pagination and write throttling', async () => {
    subject = 'Injected\r\nBcc: target@example.test';
    expect((await call('draft_reply', args, await proof())).isError).toBe(true);
    expect(writes).toBe(0);
    mode = 'cycle';
    expect((await call('search', {
        query: 'fixture'
    })).isError).toBe(true);
    expect(reads).toBeLessThanOrEqual(3);
    mode = 'write429';
    subject = 'Fixture subject';
    expect((await call('draft_reply', args, await proof())).isError).toBe(true);
    expect(writes).toBe(1);
    expect((await call('draft_reply', args, await proof())).isError).toBe(true);
    expect(writes).toBe(1);
});
test('find_slots returns common intervals in minutes and rejects unavailable calendars', async () => {
    const input = {
        attendees: ['a@example.test', 'b@example.test'], duration: 30, window: {
            start: '2026-10-25T09:00:00Z', end: '2026-10-25T12:00:00Z'
        }
    };
    const r = await call('find_slots', input);
    expect(r.isError).not.toBe(true);
    expect(JSON.stringify(r)).toContain('2026-10-25T11:00:00.000Z');
    for (const m of ['missingCalendar', 'calendarError']) {
        mode = m;
        expect((await call('find_slots', input)).isError).toBe(true);
    }
});
test('runtime resumes a lost draft through the real bridge and original encrypted evidence', async () => {
    const { runAgent } = await import('runtime/loop');
    const { PostgresStore } = await import('runtime/store');
    const { createRuntimeTool } = await import('mcp-common/bridge');
    const approvals: import('runtime/types').Approval[] = [];
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
                            id: 'fixture-call', name: 'google.draft_reply', args
                        }]
                };
        }
    };
    const tool = () => createRuntimeTool({
        tenantId: 'tenant-a', service: 'google', spec: googleTools(oauth, options())[1]!, url: server.url, token: async () => jwt(server.url), authority, approvals: () => approvals, guard: async () => 'allow'
    });
    const deps = () => ({
        store, model, tools: [tool()], approvals, guard: async () => 'allow' as const
    });
    const runId = '60000000-0000-4000-8000-000000000001', task = {
        tenantId: 'tenant-a', input: 'synthetic draft', model: 'fixture', capabilities: []
    };
    const first = await runAgent(runId, task, deps());
    expect(first.status).toBe('NEEDS_APPROVAL');
    expect(writes).toBe(0);
    approvals.push(first.approval!);
    mode = 'lost';
    expect(await runAgent(runId, task, deps())).toMatchObject({
        status: 'NEEDS_APPROVAL', errorCode: 'ACTION_UNKNOWN'
    });
    expect(writes).toBe(1);
    mode = '';
    expect(await runAgent(runId, task, deps())).toMatchObject({
        status: 'DONE', output: 'done'
    });
    expect(writes).toBe(1);
});
test('restarted server refuses changed endpoint or missing original evidence without dispatching', async () => {
    mode = 'lost';
    await call('draft_reply', args, await proof());
    expect(writes).toBe(1);
    mode = '';
    const before = requests.length;
    const replacement = await startServer({
        name: 'google', port: 0, auth: authConfig, approvalKey, journal: new ActionJournal(db.pool, db.cipher), tools: googleTools(oauth, {
            ...options(), gmailBase: provider.origin + '/replacement'
        })
    });
    try {
        expect((await fetch(replacement.origin + '/actions/lookup', {
            method: 'POST', headers: {
                Authorization: `Bearer ${jwt(replacement.url)}`
            }, body: JSON.stringify({
                actionKey: 'a'.repeat(64)
            })
        })).status).toBe(409);
        expect(requests).toHaveLength(before);
    }
    finally {
        await replacement.close();
    }
    await db.pool.query('DELETE FROM mcp_actions');
    const binding = {
        tenantId: 'tenant-a', runId: '30000000-0000-4000-8000-000000000001', tool: 'google.draft_reply', actionKey: 'a'.repeat(64), argsHash: hash(args)
    };
    await new ActionJournal(db.pool, db.cipher).reserve(binding, args, null);
    expect((await lookup()).status).toBe(409);
    expect(writes).toBe(1);
});
test('lookup rejects ambiguity, thread mismatch and absent drafts without retrying writes', async () => {
    mode = 'lost';
    await call('draft_reply', args, await proof());
    mode = '';
    const original = structuredClone(drafts[0]!);
    drafts = [original, original];
    expect((await lookup()).status).toBe(409);
    drafts = [{
            ...original, message: {
                ...original.message, threadId: 'wrong'
            }
        }];
    expect((await lookup()).status).toBe(409);
    drafts = [];
    expect((await lookup()).status).toBe(409);
    expect(writes).toBe(1);
});
test('a mismatched created draft response stays unknown', async () => {
    mode = 'wrongCreatedThread';
    expect((await call('draft_reply', args, await proof())).isError).toBe(true);
    expect(writes).toBe(1);
});
test('same mailbox email under a replacement Google subject cannot reconcile original action', async () => {
    mode = 'lost';
    await call('draft_reply', args, await proof());
    expect(writes).toBe(1);
    mode = 'changedSubject';
    expect((await lookup()).status).toBe(409);
    expect(writes).toBe(1);
});
test('draft identity requests the documented OpenID email grant only when it is missing', async () => {
    scopes = allScopes.filter(scope => scope !== 'email');
    await grant();
    expect((await call('draft_reply', args, await proof())).isError).toBe(true);
    expect(writes).toBe(0);
    expect(requests).toHaveLength(0);
    expect(consents[0]).toMatchObject({
        provider: 'google', scopes: ['email']
    });
});
test('actual consent URL orders OpenID first, retains only actual grants, and accepts canonical email scope', async () => {
    scopes = [prefix + 'gmail.readonly', prefix + 'gmail.compose'];
    await grant();
    const missing = await call('draft_reply', args, await proof());
    expect(missing).toMatchObject({
        isError: true, _meta: {
            requiredScopes: ['openid', 'email']
        }
    });
    const pending = consents[0] as {
        authUrl: string;
        state: string;
        scopes: string[];
    };
    expect(pending.scopes).toEqual(['openid', 'email']);
    expect(new URL(pending.authUrl).searchParams.get('scope')).toBe('openid email');
    expect(new URL(pending.authUrl).searchParams.get('state')).toBe(pending.state);
    expect((await oauth.getAuthorizationSnapshot('tenant-a', 'google')).scopes).toEqual(scopes);
    expect(requests).toHaveLength(0);
    scopes = [...scopes, 'openid', prefix + 'userinfo.email'];
    await grant();
    consents.length = 0;
    const result = await call('draft_reply', args, await proof());
    expect(result.isError).not.toBe(true);
    expect(consents).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/original-subject|writer@example|subjectId|authUrl|state/);
});
test('unexpected identity success response cannot masquerade as a draft acknowledgement', async () => {
    mode = 'identity201';
    expect((await call('draft_reply', args, await proof())).isError).toBe(true);
    expect(writes).toBe(0);
});
