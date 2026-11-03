import { expect, test } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { JwtVerifier } from '../src/auth.js';
import { authConfig,jwt } from './helpers.js';
const resource='http://127.0.0.1:9101/mcp';
// Removing cryptographic verification or issuer/audience/time checks permits forged or replayed authorization.
test('verifies signed MCP audience and resolves tenant only from trusted subject mapping', async()=>{
 const verifier=new JwtVerifier({...authConfig,resource});
 expect(await verifier.verifyAccessToken(jwt(resource,{tenantId:'tenant-b'}))).toMatchObject({extra:{tenantId:'tenant-a'},scopes:['mcp']});
 const wrong=generateKeyPairSync('rsa',{modulusLength:2048});
 for(const token of [jwt(resource,{},wrong.privateKey),jwt(resource,{iss:'https://evil.example'}),jwt('https://wrong.example/mcp'),jwt(resource,{exp:1}),jwt(resource,{exp:undefined}),jwt(resource,{sub:'unmapped'}),jwt(resource,{nbf:Date.now()/1000+100}), 'xoxp-provider-token']) await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
});
// An untrusted/non-TLS issuer or empty mapping is a broken deployment, not an anonymous fallback.
test('rejects unsafe authorization server configuration',()=>{
 for(const extra of [{issuer:'http://untrusted.example'},{subjects:{}},{subjects:{'subject-a':''}}])expect(()=>new JwtVerifier({...authConfig,resource,...extra})).toThrow('AUTH_CONFIG_INVALID');
});
