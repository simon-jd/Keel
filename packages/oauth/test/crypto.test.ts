import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { TokenCipher, pkceChallenge } from '../src/crypto.js';
let directory: string; let path: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'keel-oauth-')); path = join(directory, 'key'); await writeFile(path, Buffer.alloc(32, 17), { mode: 0o600 }); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
// RFC 7636 vector detects wrong hashing, encoding or padding.
test('pkceChallengeIsS256OfVerifier', () => { expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'); });
// Removing randomness or tenant/provider/field AAD must break these observable decryptions.
test('cipher authenticates record and field and uses a fresh nonce', async () => {
  const cipher = await TokenCipher.fromKeyFile(path);
  const a = cipher.encrypt('secret-token', ['tenant-a', 'google', 'access']);
  const b = cipher.encrypt('secret-token', ['tenant-a', 'google', 'access']);
  expect(a).not.toEqual(b); expect(a.toString()).not.toContain('secret-token');
  expect(cipher.decrypt(a, ['tenant-a', 'google', 'access'])).toBe('secret-token');
  for (const aad of [['tenant-b', 'google', 'access'], ['tenant-a', 'slack', 'access'], ['tenant-a', 'google', 'refresh']]) {
    expect(() => cipher.decrypt(a, aad)).toThrow('CIPHER_INVALID');
  }
  const tampered = Buffer.from(a); tampered[15] = tampered[15]! ^ 1;
  expect(() => cipher.decrypt(tampered, ['tenant-a', 'google', 'access'])).toThrow('CIPHER_INVALID');
});
// Weak permissions and malformed keys must fail closed without printing their contents.
test('rejects unsafe or malformed key files with safe errors', async () => {
  await chmod(path, 0o644); await expect(TokenCipher.fromKeyFile(path)).rejects.toThrow('KEY_INVALID');
  await chmod(path, 0o600); await writeFile(path, 'private-value'); await expect(TokenCipher.fromKeyFile(path)).rejects.toThrow('KEY_INVALID');
});
