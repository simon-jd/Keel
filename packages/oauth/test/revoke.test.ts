import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { harness } from './helpers.js';
let h: Awaited<ReturnType<typeof harness>>; let now: number;
beforeAll(async () => {
  h = await harness();
  await h.pool.query(`CREATE TABLE status_audit(status text NOT NULL);
    CREATE FUNCTION audit_oauth_status() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO status_audit VALUES (NEW.status); RETURN NEW; END; $$;
    CREATE TRIGGER audit_status AFTER INSERT OR UPDATE ON token_store FOR EACH ROW EXECUTE FUNCTION audit_oauth_status()`);
});
afterAll(async () => { await h?.cleanup(); });
afterEach(() => { expect(h.failures.splice(0)).toEqual([]); });
beforeEach(async () => { now = 1_800_000_000_000; h.requests.length = 0; await h.pool.query('TRUNCATE token_store, oauth_states, status_audit'); });
async function connected(refresh = true) {
  const service = h.service({ now: () => now });
  const started = await service.start('github', 'revoke-tenant', ['offline_access']);
  // Acceptance of offline_access must never be interpreted as an installation/repository permission.
  expect(new URL(started.authUrl).searchParams.get('scope')).toBe('offline_access');
  h.respond((_req, res) => res.end(JSON.stringify({ access_token: 'old-access', ...(refresh ? { refresh_token: 'old-refresh' } : {}), expires_in: 3600, token_type: 'bearer', scope: '' })));
  expect((await service.callback('code', started.state)).scopes).toEqual([]);
  await h.pool.query('TRUNCATE status_audit'); return service;
}
async function assertPersistedDenial() {
  expect((await h.pool2.query('SELECT status FROM token_store')).rows).toEqual([{ status: 'revoked' }]);
  expect((await h.pool2.query("SELECT * FROM status_audit WHERE status <> 'revoked'")).rows).toEqual([]);
}
// Revoking with expired GitHub access requires one refresh, with no temporary active write.
test('expired GitHub access refreshes once under durable denial before grant revocation', async () => {
  const service = await connected(); now += 3_600_001;
  h.respond(async (req, res) => {
    await assertPersistedDenial();
    if (req.path.endsWith('/token')) {
      expect(req.body.get('refresh_token')).toBe('old-refresh');
      res.end(JSON.stringify({ access_token: 'revocation-access', refresh_token: 'revocation-refresh', expires_in: 3600, token_type: 'bearer', scope: '' }));
    } else {
      if (JSON.parse(req.raw).access_token !== 'revocation-access') { res.statusCode = 401; res.end('{}'); return; }
      expect(req.method).toBe('DELETE'); res.statusCode = 204; res.end();
    }
  });
  await service.revoke('revoke-tenant', 'github'); await assertPersistedDenial();
  expect(h.requests.filter(r => r.body.get('grant_type') === 'refresh_token')).toHaveLength(1);
  await expect(h.service({}, true).getAccessToken('revoke-tenant', 'github')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  expect((await h.pool.query('SELECT enc_access, enc_refresh FROM token_store')).rows).toEqual([{ enc_access: null, enc_refresh: null }]);
});
// A failed revoke must keep rotated credentials usable for a later revoke after another expiry.
test('failed GitHub revoke retries across expiry using persisted rotation while remaining denied', async () => {
  const service = await connected();
  h.respond((_req, res) => { res.statusCode = 503; res.end('{}'); });
  await expect(service.revoke('revoke-tenant', 'github')).rejects.toMatchObject({ code: 'REVOKE_FAILED' });
  await assertPersistedDenial(); now += 3_600_001;
  h.respond(async (req, res) => {
    await assertPersistedDenial();
    if (req.path.endsWith('/token')) {
      expect(req.body.get('refresh_token')).toBe('old-refresh');
      res.end(JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'bearer', scope: '' }));
    } else { res.statusCode = 503; res.end('{}'); }
  });
  await expect(h.service({ now: () => now }, true).revoke('revoke-tenant', 'github')).rejects.toMatchObject({ code: 'REVOKE_FAILED' });
  expect(h.requests.filter(r => r.body.get('grant_type') === 'refresh_token')).toHaveLength(1);
  await assertPersistedDenial();
  await expect(service.getAccessToken('revoke-tenant', 'github')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  now += 3_600_001;
  h.respond(async (req, res) => {
    await assertPersistedDenial();
    if (req.path.endsWith('/token')) {
      expect(req.body.get('refresh_token')).toBe('rotated-refresh');
      res.end(JSON.stringify({ access_token: 'final-access', refresh_token: 'final-refresh', expires_in: 3600, token_type: 'bearer', scope: '' }));
    } else { expect(JSON.parse(req.raw).access_token).toBe('final-access'); res.statusCode = 204; res.end(); }
  });
  await service.revoke('revoke-tenant', 'github'); await assertPersistedDenial();
  expect(h.requests.filter(r => r.body.get('grant_type') === 'refresh_token')).toHaveLength(2);
});
// Missing refresh must not be mistaken for successful upstream removal of an expired grant.
test('expired GitHub access without refresh cannot report successful grant revocation', async () => {
  const service = await connected(false); now += 3_600_001;
  h.respond((_req, res) => { res.statusCode = 204; res.end(); });
  await expect(service.revoke('revoke-tenant', 'github')).rejects.toMatchObject({ code: 'REVOKE_FAILED' });
  await assertPersistedDenial(); expect(h.requests).toHaveLength(1);
});
