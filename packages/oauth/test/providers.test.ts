import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { harness } from './helpers.js';
import { slack, github, google, salesforce } from '../src/providers/index.js';
import { OAuthService } from '../src/flow.js';
import { PostgresTokenStore } from '../src/store.js';
let h: Awaited<ReturnType<typeof harness>>;
afterEach(() => { const failures=h.failures.splice(0); expect(failures).toEqual([]); });
beforeAll(async()=> { h=await harness(); }); afterAll(async()=>{ await h?.cleanup(); });
beforeEach(async()=>{ await h.pool.query('TRUNCATE token_store,oauth_states'); h.requests.length=0; });
// Slack authed_user credentials must stay together, never borrowed from the bot envelope.
test('Slack user consent and rotating response preserve user identity', async()=> {
  let now=1_800_000_000_000; const service=h.service({now:()=>now});
  const started=await service.start('slack','t',['search:read']); const url=new URL(started.authUrl);
  expect(url.searchParams.get('user_scope')).toBe('search:read'); expect(url.searchParams.has('scope')).toBe(false);
  h.respond((req,res)=>{ expect(req.body.has('client_secret')).toBe(false); res.end(JSON.stringify({ok:true,access_token:'bot-access',refresh_token:'bot-refresh',scope:'chat:write',token_type:'bot',expires_in:9999,authed_user:{id:'U1',access_token:'user-access',refresh_token:'user-refresh',scope:'search:read',token_type:'user',expires_in:3600}})); });
  expect(await service.callback('code',started.state)).toMatchObject({accessToken:'user-access',refreshToken:'user-refresh',identity:'slack-user',scopes:['search:read']}); now+=3_541_000;
  h.respond((req,res)=>{ expect(req.body.get('refresh_token')).toBe('user-refresh'); res.end(JSON.stringify({ok:true,access_token:'user-new',refresh_token:'user-new-refresh',scope:'search:read',token_type:'user',expires_in:3600})); });
  expect(await service.getAccessToken('t','slack')).toBe('user-new');
  h.respond((req,res)=>{ expect(req.body.get('token')).toBe('user-new'); res.end(JSON.stringify({ok:true,revoked:true})); });
  await service.revoke('t','slack');
});
// Bot mode must not accept user records, and Slack's HTTP-200 error envelope is an error.
test('Slack bot is separate and semantic errors are rejected',async()=>{
  const service=new OAuthService(new PostgresTokenStore(h.pool,h.cipher),[slack({...h.config('slack'),redirectUri:'https://keel.example/callback',tokenKind:'bot'})]);
  const started=await service.start('slack','t',['chat:write']); expect(new URL(started.authUrl).searchParams.get('scope')).toBe('chat:write');
  h.respond((_req,res)=>res.end(JSON.stringify({ok:true,access_token:'bot',token_type:'bot',scope:'chat:write',authed_user:{access_token:'user',scope:'search:read'}})));
  expect(await service.callback('code',started.state)).toMatchObject({accessToken:'bot',identity:'slack-bot',expiresAt:null});
  await expect(h.service().getAccessToken('t','slack')).rejects.toMatchObject({code:'IDENTITY_MISMATCH'});
  const error=await service.start('slack','t',['chat:write']); h.respond((_req,res)=>res.end(JSON.stringify({ok:false,error:'bad_verifier',detail:'private'})));
  await expect(service.callback('code',error.state)).rejects.toMatchObject({code:'PROVIDER_ERROR'});
});
// GitHub App scopes are not installation permissions; revoke uses the app-grant DELETE protocol.
test('GitHub App user OAuth handles optional expiry and authenticated grant revocation',async()=>{
  const service=h.service(); await expect(service.start('github','t',['repo'])).rejects.toMatchObject({code:'CONFIG_INVALID'});
  const started=await service.start('github','t',[]); expect(new URL(started.authUrl).searchParams.get('code_challenge_method')).toBe('S256');
  h.respond((req,res)=>{ expect(req.headers.accept).toBe('application/json'); res.end(JSON.stringify({access_token:'ghu_user',token_type:'bearer',scope:''})); });
  expect(await service.callback('code',started.state)).toMatchObject({identity:'github-app-user',expiresAt:null,refreshToken:null,scopes:[]});
  h.respond((req,res)=>{ expect(req.method).toBe('DELETE'); expect(JSON.parse(req.raw)).toEqual({access_token:'ghu_user'}); expect(req.headers.authorization).toBe('Basic '+Buffer.from('client:client-secret').toString('base64')); res.statusCode=204; res.end(); });
  await service.revoke('t','github');
});
// Google must request incremental offline consent and honor actual reduced or omitted scope semantics.
test('Google incremental consent honors granted scopes instead of unioning requested scopes',async()=>{
  const service=h.service(); const started=await service.start('google','t',['read','write']); const url=new URL(started.authUrl);
  expect(url.searchParams.get('include_granted_scopes')).toBe('true'); expect(url.searchParams.get('access_type')).toBe('offline');
  h.respond((_req,res)=>res.end(JSON.stringify({access_token:'google',scope:'read',expires_in:3600,token_type:'Bearer'})));
  expect((await service.callback('code',started.state)).scopes).toEqual(['read']);
  const second=await service.start('google','t',['read']); h.respond((_req,res)=>res.end(JSON.stringify({access_token:'google2',expires_in:3600,token_type:'Bearer'})));
  expect((await service.callback('code',second.state)).scopes).toEqual(['read']);
});
// Salesforce MyDomain endpoints and session tokens do not promise an expires_in duration.
test('Salesforce MyDomain configuration and refresh preserve endpoint and omitted fields',async()=>{
  const adapter=salesforce({clientId:'id',clientSecret:'secret',redirectUri:'http://127.0.0.1/callback',loginOrigin:'https://sandbox-dev-ed.my.salesforce.com'});
  expect(new URL(adapter.authorize('state','challenge',['api','refresh_token'])).origin).toBe('https://sandbox-dev-ed.my.salesforce.com');
  expect(new URL(adapter.authorize('state','challenge',['api'])).pathname).toBe('/services/oauth2/authorize');
  const service=h.service(); const started=await service.start('salesforce','t',['api','refresh_token']);
  h.respond((_req,res)=>res.end(JSON.stringify({access_token:'sf-access',refresh_token:'sf-refresh',instance_url:'https://sandbox-dev-ed.my.salesforce.com',id:'https://login.salesforce.com/id/org/user',issued_at:'1800000000000',signature:'signature',scope:'api refresh_token',token_type:'Bearer'})));
  expect(await service.callback('code',started.state)).toMatchObject({expiresAt:null,identity:'salesforce-user'});
  h.respond((req,res)=>{ expect(req.body.get('grant_type')).toBe('refresh_token'); expect(req.body.get('refresh_token')).toBe('sf-refresh'); res.end(JSON.stringify({access_token:'sf-new',instance_url:'https://sandbox-dev-ed.my.salesforce.com',issued_at:'1800001000000',signature:'signature',token_type:'Bearer'})); });
  expect(await service.refreshAfterUnauthorized('t','salesforce','sf-access')).toBe('sf-new');
  h.respond((req,res)=>{ expect(req.body.get('token')).toBe('sf-refresh'); res.end(''); }); await service.revoke('t','salesforce');
});
// Transport misconfiguration cannot leak client credentials through plain HTTP or URL redirects.
test('provider configuration rejects remote cleartext and malformed Salesforce domains',()=>{
  for(const factory of [google,github,slack]) expect(()=>factory({...h.config('provider'),endpoints:{authorize:'http://example.com/auth',token:'http://example.com/token',revoke:'http://example.com/revoke'}})).toThrow('CONFIG_INVALID');
  expect(()=>salesforce({...h.config('sf'),loginOrigin:'https://evil.example.com'})).toThrow('CONFIG_INVALID');
});
// Rotating providers promise a new refresh token; silently retaining a spent value is unsafe.
test.each(['slack','github'] as const)('%s rejects a refresh response missing its rotated refresh token',async provider=>{
  let now=1_800_000_000_000; const service=h.service({now:()=>now});
  const started=await service.start(provider,'t',provider==='slack' ? ['search:read']:[]);
  h.respond((_req,res)=>res.end(JSON.stringify(provider==='slack' ? {ok:true,authed_user:{access_token:'old',refresh_token:'refresh',token_type:'user',scope:'search:read',expires_in:3600}} : {access_token:'old',refresh_token:'refresh',expires_in:3600,token_type:'bearer',scope:''})));
  await service.callback('code',started.state); now+=3_541_000;
  h.respond((_req,res)=>res.end(JSON.stringify(provider==='slack' ? {ok:true,access_token:'new',token_type:'user',scope:'search:read',expires_in:3600} : {access_token:'new',expires_in:3600,token_type:'bearer',scope:''})));
  await expect(service.getAccessToken('t',provider)).rejects.toMatchObject({code:'RECONSENT_REQUIRED'});
  await expect(h.service({},true).getAccessToken('t',provider)).rejects.toMatchObject({code:'RECONSENT_REQUIRED'});
});
// Changing client registration must not send credentials belonging to the old grant to a new app.
test('stored grants are bound to provider client configuration',async()=>{
  const service=h.service(); const started=await service.start('google','t',['read']);
  h.respond((_req,res)=>res.end(JSON.stringify({access_token:'access',refresh_token:'refresh',scope:'read',expires_in:3600})));
  await service.callback('code',started.state);
  const changed=new OAuthService(new PostgresTokenStore(h.pool2,h.cipher),[google({...h.config('google'),clientId:'another-app'})]);
  await expect(changed.getAccessToken('t','google')).rejects.toMatchObject({code:'IDENTITY_MISMATCH'});
  expect(h.requests).toHaveLength(1);
});
// Endpoint binding in encrypted state rejects registration changes before exposing the code/verifier.
test('callback rejects a changed redirect registration',async()=>{
  const started=await h.service().start('google','t',['read']);
  const changed=new OAuthService(new PostgresTokenStore(h.pool2,h.cipher),[google({...h.config('google'),redirectUri:'http://127.0.0.1/different'})]);
  await expect(changed.callback('code',started.state)).rejects.toMatchObject({code:'STATE_INVALID'}); expect(h.requests).toHaveLength(0);
});
// Reject redirects and malformed/oversized responses, without exposing body or credentials in errors.
test.each(['redirect','malformed','oversized'] as const)('rejects unsafe provider %s response',async mode=>{
  const service=h.service(); const started=await service.start('google','t',['read']);
  h.respond((_req,res)=>{ if(mode==='redirect'){res.statusCode=302;res.setHeader('location',h.origin+'/stolen');res.end();} else res.end(mode==='malformed' ? 'private-token' : 'x'.repeat(70_000)); });
  await expect(service.callback('code',started.state)).rejects.toThrow(/^PROVIDER_(ERROR|INVALID)$/); expect(h.requests).toHaveLength(1);
});
// Slack declares PKCE localhost redirects public/desktop and disallows bot scopes there.
test('Slack refuses desktop bot consent and omits public refresh secrets',async()=>{
  expect(()=>slack({...h.config('slack'),redirectUri:'http://localhost/callback',tokenKind:'bot'})).toThrow('CONFIG_INVALID');
  let now=1_800_000_000_000; const service=h.service({now:()=>now}); const started=await service.start('slack','t',['search:read']);
  h.respond((_req,res)=>res.end(JSON.stringify({ok:true,authed_user:{access_token:'user',refresh_token:'refresh',token_type:'user',scope:'search:read',expires_in:3600}})));
  await service.callback('code',started.state); now+=3_541_000;
  h.respond((req,res)=>{expect(req.body.has('client_secret')).toBe(false);res.end(JSON.stringify({ok:true,access_token:'next',refresh_token:'next-refresh',token_type:'user',scope:'search:read',expires_in:3600}));});
  await service.getAccessToken('t','slack');
});
// Installed clients cannot request Google's web-only incremental authorization behavior.
test('Google distinguishes desktop PKCE from confidential incremental web clients',()=>{
  const desktop=google({...h.config('google'),clientType:'desktop'});
  const url=new URL(desktop.authorize('state','challenge',['read']));
  expect(url.searchParams.has('include_granted_scopes')).toBe(false); expect(url.searchParams.get('code_challenge')).toBe('challenge');
  expect(()=>google({clientId:'id',redirectUri:'https://keel.example/callback',clientType:'web'})).toThrow('CONFIG_INVALID');
});
