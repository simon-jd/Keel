import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyGithubWebhook(body: Buffer, signature: string, secret: string): boolean {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(body).digest(), Buffer.from(signature.slice(7), 'hex'));
}
