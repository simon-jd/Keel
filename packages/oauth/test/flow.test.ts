import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { harness } from './helpers.js';
let h: Awaited<ReturnType<typeof harness>>;
afterEach(() => { const failures=h.failures.splice(0); expect(failures).toEqual([]); });
let now = 1_800_000_000_000;
beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h?.cleanup(); });
beforeEach(async () => {
  await h.pool.query('TRUNCATE token_store, oauth_states'); h.requests.length = 0; now = 1_800_000_000_000;
  h.respond((_req, res) => res.end(JSON.stringify({ access_token: 'access-original', refresh_token: 'refresh-original', expires_in: 3600, scope: 'read write', token_type: 'Bearer' })));
});
async function connected() { const service = h.service({ now: () => now }); const started = await service.start('google', 'tenant-a', ['read','write']); await service.callback('auth-code', started.state); return service; }
// A random unissued state must never reach the provider.
test('stateMismatchRejected', async () => { await expect(h.service().callback('code', 'unissued-state')).rejects.toMatchObject({ code: 'STATE_INVALID' }); expect(h.requests).toHaveLength(0); });
// Removing state persistence, encryption, single-use, or the bound verifier breaks this exchange.
test('persistent one-use state binds PKCE and redirect across independent instances', async () => {
  const first = h.service({ now: () => now }); const second = h.service({ now: () => now }, true);
  const started = await first.start('google', 'tenant-a', ['read','write']); const url = new URL(started.authUrl);
  expect(Object.keys(started).sort()).toEqual(['authUrl','state']); expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const rows = (await h.pool.query('SELECT * FROM oauth_states')).rows;
  expect(rows[0].state_hash).not.toBe(started.state); expect(rows[0].enc_payload).toBeInstanceOf(Buffer);
  const tokens = await second.callback('auth-code', started.state);
  const request = h.requests[0]!; const verifier = request.body.get('code_verifier')!;
  expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  expect(request.body.get('redirect_uri')).toBe('http://127.0.0.1/callback'); expect(request.body.get('code')).toBe('auth-code');
  expect(rows[0].enc_payload.toString()).not.toContain(verifier);
  expect(tokens.accessToken).toBe('access-original'); expect(await second.getAccessToken('tenant-a','google')).toBe('access-original');
  await expect(first.callback('auth-code', started.state)).rejects.toMatchObject({ code: 'STATE_INVALID' }); expect(h.requests).toHaveLength(1);
  const stored = (await h.pool.query('SELECT * FROM token_store')).rows[0];
  expect(stored.enc_access.toString()).not.toContain('access-original'); expect(stored.enc_refresh.toString()).not.toContain('refresh-original');
});
// Expiration and consumption must precede the token HTTP boundary, including failed exchanges.
test('expired and failed callback states cannot replay', async () => {
  const service = h.service({ now: () => now, stateTtlMs: 1000 }); const expired = await service.start('google','tenant-a',['read']); now += 1000;
  await expect(service.callback('code',expired.state)).rejects.toMatchObject({ code: 'STATE_INVALID' }); expect(h.requests).toHaveLength(0);
  const failed = await service.start('google','tenant-a',['read']); h.respond((_req,res) => { res.statusCode = 400; res.end(JSON.stringify({ error:'invalid_grant',error_description:'PII private token' })); });
  await expect(service.callback('code',failed.state)).rejects.toMatchObject({ code: 'INVALID_GRANT' });
  await expect(service.callback('code',failed.state)).rejects.toMatchObject({ code: 'STATE_INVALID' }); expect(h.requests).toHaveLength(1);
});
// Ten callers split between independent pools must not spend a rotating refresh token twice.
test('singleFlightRefresh', async () => {
  const first = await connected(); const second = h.service({ now: () => now }, true); now += 3_541_000;
  h.respond((req,res) => { expect(req.body.get('grant_type')).toBe('refresh_token'); expect(req.body.get('refresh_token')).toBe('refresh-original'); setTimeout(() => res.end(JSON.stringify({ access_token:'access-rotated',refresh_token:'refresh-rotated',expires_in:3600,scope:'read' })), 50); });
  expect(await Promise.all(Array.from({ length:10 }, (_,i) => (i % 2 ? first : second).getAccessToken('tenant-a','google')))).toEqual(Array(10).fill('access-rotated'));
  expect(h.requests.filter(r => r.body.get('grant_type') === 'refresh_token')).toHaveLength(1);
});
// Persisting only access, or blindly unioning scopes, loses rotation or overgrants permissions.
test('refreshRotationPersistsNewRefreshToken', async () => {
  const service = await connected(); now += 3_541_000;
  h.respond((_req,res) => res.end(JSON.stringify({ access_token:'access-rotated', refresh_token:'refresh-rotated',expires_in:3600,scope:'read' })));
  await service.getAccessToken('tenant-a','google'); now += 3_541_000;
  h.respond((req,res) => { expect(req.body.get('refresh_token')).toBe('refresh-rotated'); res.end(JSON.stringify({ access_token:'access-final', expires_in:3600 })); });
  expect(await h.service({ now: () => now },true).getAccessToken('tenant-a','google')).toBe('access-final');
  expect((await h.pool.query('SELECT scopes FROM token_store')).rows).toEqual([{ scopes:['read'] }]);
  now += 3_541_000; await service.getAccessToken('tenant-a','google'); expect(h.requests.at(-1)!.body.get('refresh_token')).toBe('refresh-rotated');
});
// invalid_grant must commit reconsent and forbid the still-unexpired old token on future calls.
test('invalidGrantMarksReconsentRequired', async () => {
  const service = await connected(); now += 3_541_000;
  h.respond((_req,res) => { res.statusCode = 400; res.end(JSON.stringify({ error:'invalid_grant',error_description:'secret' })); });
  await expect(service.getAccessToken('tenant-a','google')).rejects.toMatchObject({ code:'RECONSENT_REQUIRED' });
  await expect(h.service({},true).getAccessToken('tenant-a','google')).rejects.toMatchObject({ code:'RECONSENT_REQUIRED' });
  expect((await h.pool.query('SELECT status FROM token_store')).rows).toEqual([{ status:'reconsent' }]); expect(h.requests).toHaveLength(2);
});
// Refresh threshold is strictly less than 60 seconds, not <= or expired-only.
test('refreshes below sixty seconds and never invents expiry', async () => {
  const service = await connected(); now += 3_540_000; await service.getAccessToken('tenant-a','google'); expect(h.requests).toHaveLength(1);
  now += 1; await service.getAccessToken('tenant-a','google'); expect(h.requests).toHaveLength(2);
  h.respond((_req,res) => res.end(JSON.stringify({ access_token:'no-expiry',scope:'read' })));
  const started = await service.start('google','tenant-b',['read']); expect((await service.callback('code', started.state)).expiresAt).toBeNull(); now += 1_000_000_000;
  expect(await service.getAccessToken('tenant-b','google')).toBe('no-expiry'); expect(h.requests).toHaveLength(3);
});
// A new consent may select another account; it cannot inherit an old grant's refresh token.
test('new authorization never combines old refresh or scopes with a new account', async () => {
  const service = await connected(); h.respond((_req,res) => res.end(JSON.stringify({ access_token:'different-account',expires_in:3600,scope:'read' })));
  const started = await service.start('google','tenant-a',['read']); const token = await service.callback('code', started.state);
  expect(token.refreshToken).toBeNull(); expect(token.scopes).toEqual(['read']); now += 3_541_000;
  await expect(service.getAccessToken('tenant-a','google')).rejects.toMatchObject({ code:'RECONSENT_REQUIRED' }); expect(h.requests).toHaveLength(2);
});
// Local revocation must survive upstream failure and invalidate outstanding callback state.
test('revoke persists denial, retries upstream, and cancels pending callbacks', async () => {
  const service = await connected(); const pending = await service.start('google','tenant-a',['read']);
  h.respond((_req,res) => { res.statusCode=503; res.end('private response'); });
  await expect(service.revoke('tenant-a','google')).rejects.toMatchObject({ code:'REVOKE_FAILED' });
  await expect(h.service({},true).getAccessToken('tenant-a','google')).rejects.toMatchObject({ code:'NOT_CONNECTED' });
  await expect(service.callback('code',pending.state)).rejects.toMatchObject({ code:'STATE_INVALID' });
  h.respond((req,res) => { expect(req.body.get('token')).toBe('refresh-original'); res.end(''); });
  await service.revoke('tenant-a','google'); expect((await h.pool.query('SELECT status,enc_access,enc_refresh FROM token_store')).rows).toEqual([{ status:'revoked',enc_access:null,enc_refresh:null }]);
});
// A hung provider cannot monopolize the DB lock; sanitized error output cannot carry any payload.
test('tokensNeverLogged', async () => {
  const logs: unknown[] = []; const errors: unknown[] = [];
  const service = h.service({ now: () => now, logger: event => logs.push(event) });
  const started = await service.start('google','pii@example.com',['read']); await service.callback('auth-code',started.state); now += 3_541_000;
  h.respond((_req,res) => { res.statusCode=400; res.end(JSON.stringify({ error:'invalid_grant',error_description:'access-original refresh-original client-secret pii@example.com auth-code' })); });
  try { await service.getAccessToken('pii@example.com','google'); } catch (e) { errors.push(e); }
  try { await service.revoke('pii@example.com','google'); } catch (e) { errors.push(e); }
  expect(logs.length).toBeGreaterThan(0); expect(errors).toHaveLength(2);
  const output = JSON.stringify({ logs, errors: errors.map(e => ({ ...(e as Error), message: (e as Error).message, stack: (e as Error).stack })) });
  for (const secret of ['access-original','refresh-original','client-secret','pii@example.com','auth-code',started.state]) expect(output).not.toContain(secret);
});
// This port supports Salesforce session timeouts; stale 401s may only refresh once.
test('concurrent unauthorized recovery reuses the refreshed token', async () => {
  const service = await connected(); const second = h.service({ now:()=>now }, true);
  h.respond((_req,res) => setTimeout(() => res.end(JSON.stringify({ access_token:'after-401', refresh_token:'rotated',scope:'read' })), 40));
  expect(await Promise.all(Array.from({ length:10 },(_,i)=>(i%2 ? service : second).refreshAfterUnauthorized('tenant-a','google','access-original')))).toEqual(Array(10).fill('after-401'));
  expect(h.requests).toHaveLength(2);
});
// Bound network timeouts must release the distributed lock and preserve a safe public exception.
test('provider timeout releases the lock', async () => {
  const service = await connected(); now += 3_541_000; h.respond(() => {});
  await expect(service.getAccessToken('tenant-a','google')).rejects.toMatchObject({ code:'PROVIDER_ERROR' });
  h.respond((_req,res) => res.end(JSON.stringify({ access_token:'after-timeout',expires_in:3600 })));
  expect(await h.service({ now:()=>now },true).getAccessToken('tenant-a','google')).toBe('after-timeout');
});
// Both callbacks may peek before locking, but only one can consume state and exchange the code.
test('concurrent callbacks exchange a state only once',async()=>{
  const first=h.service({now:()=>now}); const second=h.service({now:()=>now},true); const started=await first.start('google','tenant-a',['read']);
  const result=await Promise.allSettled([first.callback('code',started.state),second.callback('code',started.state)]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1); expect(result.filter(r=>r.status==='rejected')).toHaveLength(1); expect(h.requests).toHaveLength(1);
});
// Revoke waits for a callback already exchanging and then disables its newly persisted token.
test('revoke racing an in-flight callback cannot resurrect credentials',async()=>{
  const first=h.service({now:()=>now}); const second=h.service({now:()=>now},true); const started=await first.start('google','tenant-a',['read']);
  let release!:()=>void; let seen!:()=>void; const reached=new Promise<void>(resolve=>{seen=resolve;});
  h.respond((req,res)=>{ if(req.path.endsWith('/token')) { release=()=>res.end(JSON.stringify({access_token:'racing-access',refresh_token:'racing-refresh',scope:'read'})); seen(); } else res.end(''); });
  const callback=first.callback('code',started.state); await reached; const revocation=second.revoke('tenant-a','google'); release(); await callback; await revocation;
  await expect(first.getAccessToken('tenant-a','google')).rejects.toMatchObject({code:'NOT_CONNECTED'});
});
// Changing ciphertext between tenants must fail authentication at the persistence boundary.
test('database ciphertext swaps across tenants fail closed',async()=>{
  const service=await connected(); const started=await service.start('google','tenant-b',['read']); await service.callback('code',started.state);
  await h.pool.query("UPDATE token_store SET enc_access=(SELECT enc_access FROM token_store WHERE tenant_id='tenant-a') WHERE tenant_id='tenant-b'");
  await expect(service.getAccessToken('tenant-b','google')).rejects.toMatchObject({code:'CIPHER_INVALID'});
  await expect(service.getAccessToken('missing','google')).rejects.toMatchObject({code:'NOT_CONNECTED'});
});
// MCP must receive the scopes of the same access token, never a separate pre-refresh scope read.
test('authorization snapshot atomically returns the refreshed token and actual scopes',async()=>{
  const service=await connected(); now+=3_541_000;
  h.respond((_req,res)=>res.end(JSON.stringify({access_token:'limited',refresh_token:'limited-refresh',scope:'read',expires_in:3600})));
  const snapshot=await service.getAuthorizationSnapshot('tenant-a','google');
  expect(snapshot).toEqual({accessToken:'limited',identity:'google-user',scopes:['read'],expiresAt:new Date(now+3_600_000)});
  expect(snapshot).not.toHaveProperty('refreshToken');
});
