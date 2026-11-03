import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { verifyGithubWebhook } from '../src/webhook.js';
// Accepting malformed signatures or serializing before verification breaks raw-byte authenticity.
test('githubHmacVerified', () => {
 const body = Buffer.from('{ "action": "opened" }');
 const signature = 'sha256=' + createHmac('sha256','fixture-secret').update(body).digest('hex');
 expect(verifyGithubWebhook(body, signature, 'fixture-secret')).toBe(true);
 for (const bad of ['sha1=abc','sha256=xx','',signature+'0']) expect(verifyGithubWebhook(body,bad,'fixture-secret')).toBe(false);
 expect(verifyGithubWebhook(Buffer.from('{"action":"opened"}'),signature,'fixture-secret')).toBe(false);
});
