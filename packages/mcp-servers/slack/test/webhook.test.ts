import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { verifySlackWebhook } from '../src/webhook.js';
const body = Buffer.from('{"type":"event_callback", "event":{"text":"fixture"}}');
const now = 1_800_000_000;
const signature = (timestamp: string) => 'v0=' + createHmac('sha256', 'fixture-secret').update(`v0:${timestamp}:`).update(body).digest('hex');
// Removing byte authentication permits an altered payload.
test('rejectsTamperedSlackSignature', () => {
  expect(verifySlackWebhook(body, String(now), signature(String(now)), 'fixture-secret', now)).toBe(true);
  expect(verifySlackWebhook(Buffer.from(body.toString().replace('fixture','changed')), String(now), signature(String(now)), 'fixture-secret', now)).toBe(false);
});
// Removing the bidirectional replay window accepts stale or future signed requests.
test('rejectsStaleSlackTimestamp', () => {
  for (const timestamp of [String(now-301), String(now+301), '1e9', '', 'NaN']) expect(verifySlackWebhook(body, timestamp, signature(timestamp), 'fixture-secret', now)).toBe(false);
  for (const timestamp of [String(now-300), String(now+300)]) expect(verifySlackWebhook(body, timestamp, signature(timestamp), 'fixture-secret', now)).toBe(true);
});
