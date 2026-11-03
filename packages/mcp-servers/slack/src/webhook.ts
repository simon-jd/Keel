import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifySlackWebhook(body: Buffer, timestamp: string, signature: string, secret: string, now = Date.now() / 1000): boolean {
  if (!secret || !/^\d{1,12}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300 || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'));
}
