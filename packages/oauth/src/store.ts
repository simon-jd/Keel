import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { acquire, type DatabaseSession } from './session.js';
import type { TokenCipher } from './crypto.js';
import { OAuthError, safeError } from './errors.js';
import type { Identity, PendingState, Provider, TokenSet } from './types.js';
interface StateRow {
    tenant_id: string;
    provider: Provider;
    enc_payload: Buffer;
}
interface TokenRow {
    binding: string;
    identity: Identity;
    enc_access: Buffer | null;
    enc_refresh: Buffer | null;
    expires_at: Date | null;
    scopes: string[];
    status: 'active' | 'reconsent' | 'revoked';
}
export interface StoredToken {
    binding: string;
    status: TokenRow['status'];
    token: TokenSet | null;
}
const hashState = (state: string) => createHash('sha256').update(state).digest('hex');
/** All mutations for a tenant/provider must use withLock, including callback and revoke.
 * Session advisory lock permits durable state consumption / local revocation before HTTP.
 * Atomic upserts persist access+refresh rotation together. No in-process locking is used. */
export class PostgresTokenStore {
    private readonly timeoutMs: number;
    constructor(private readonly pool: Pool, private readonly cipher: TokenCipher, options: { timeoutMs?: number } = {}) {
        this.timeoutMs = options.timeoutMs ?? 15000;
        const connectionTimeout = pool.options.connectionTimeoutMillis;
        if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15000 ||
            !connectionTimeout || !Number.isInteger(connectionTimeout) || connectionTimeout < 1 || connectionTimeout > 15000)
            throw new OAuthError('CONFIG_INVALID');
    }
    private async withClient<T>(run: (client: DatabaseSession) => Promise<T>): Promise<T> {
        try {
            const client = await acquire(this.pool, this.timeoutMs);
            try {
                // Numeric configuration was validated in the constructor. The local timer also
                // bounds this setup query before the server-side timeout has been installed.
                await client.query(`SET statement_timeout = ${this.timeoutMs}`);
                return await run(client);
            } finally { await client.release(); }
        } catch (error) { throw safeError(error); }
    }
    async withLock<T>(tenant: string, provider: Provider, run: (client: DatabaseSession) => Promise<T>): Promise<T> {
        const key = JSON.stringify(['keel-oauth', tenant, provider]);
        return this.withClient(async client => {
            await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
            try { return await run(client); }
            finally {
                if (!client.destroyed)
                    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
            }
        });
    }
    async peekState(state: string): Promise<{ tenantId: string; provider: Provider }> {
        return this.withClient(async client => {
            const result = await client.query<StateRow>('SELECT tenant_id, provider FROM oauth_states WHERE state_hash=$1', [hashState(state)]);
            const row = result.rows[0];
            if (!row) throw new OAuthError('STATE_INVALID');
            return { tenantId: row.tenant_id, provider: row.provider };
        });
    }
    async createState(client: DatabaseSession, state: string, pending: PendingState, expires: Date): Promise<void> {
        const hash = hashState(state);
        await client.query('INSERT INTO oauth_states(state_hash,tenant_id,provider,enc_payload,expires_at) VALUES($1,$2,$3,$4,$5)', [hash, pending.tenantId, pending.provider, this.cipher.encrypt(JSON.stringify(pending), [pending.tenantId, pending.provider, 'state', hash]), expires]);
    }
    async consumeState(client: DatabaseSession, state: string, now: number): Promise<PendingState> {
        const hash = hashState(state);
        // Consume expired states too: DELETE is committed before checking expiry or contacting SaaS.
        const result = await client.query<StateRow & {
            expires_at: Date;
        }>('DELETE FROM oauth_states WHERE state_hash=$1 RETURNING *', [hash]);
        const row = result.rows[0];
        if (!row || row.expires_at.getTime() <= now)
            throw new OAuthError('STATE_INVALID');
        return JSON.parse(this.cipher.decrypt(row.enc_payload, [row.tenant_id, row.provider, 'state', hash])) as PendingState;
    }
    async read(client: DatabaseSession, tenant: string, provider: Provider): Promise<StoredToken | null> {
        const row = (await client.query<TokenRow>('SELECT * FROM token_store WHERE tenant_id=$1 AND provider=$2', [tenant, provider])).rows[0];
        if (!row)
            return null;
        return { binding: row.binding, status: row.status, token: row.enc_access === null ? null : { identity: row.identity,
                accessToken: this.cipher.decrypt(row.enc_access, [tenant, provider, 'access', row.identity]),
                refreshToken: row.enc_refresh === null ? null : this.cipher.decrypt(row.enc_refresh, [tenant, provider, 'refresh', row.identity]),
                expiresAt: row.expires_at, scopes: row.scopes } };
    }
    async write(client: DatabaseSession, tenant: string, provider: Provider, token: TokenSet, binding: string, status: 'active' | 'revoked' = 'active'): Promise<void> {
        await client.query(`INSERT INTO token_store(tenant_id,provider,identity,enc_access,enc_refresh,expires_at,scopes,status,binding)
      VALUES($1,$2,$3,$4,$5,$6,$7,$9,$8) ON CONFLICT(tenant_id,provider) DO UPDATE SET
      identity=EXCLUDED.identity,enc_access=EXCLUDED.enc_access,enc_refresh=EXCLUDED.enc_refresh,
      expires_at=EXCLUDED.expires_at,scopes=EXCLUDED.scopes,status=EXCLUDED.status,binding=EXCLUDED.binding`, [tenant, provider, token.identity,
            this.cipher.encrypt(token.accessToken, [tenant, provider, 'access', token.identity]),
            token.refreshToken === null ? null : this.cipher.encrypt(token.refreshToken, [tenant, provider, 'refresh', token.identity]), token.expiresAt, token.scopes, binding, status]);
    }
    async mark(client: DatabaseSession, tenant: string, provider: Provider, status: 'reconsent' | 'revoked', clear = false): Promise<void> {
        await client.query(`UPDATE token_store SET status=$3${clear ? ', enc_access=NULL, enc_refresh=NULL' : ''} WHERE tenant_id=$1 AND provider=$2`, [tenant, provider, status]);
    }
    async cancelStates(client: DatabaseSession, tenant: string, provider: Provider): Promise<void> {
        await client.query('DELETE FROM oauth_states WHERE tenant_id=$1 AND provider=$2', [tenant, provider]);
    }
}
