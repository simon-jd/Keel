import { randomBytes } from 'node:crypto';
import { pkceChallenge } from './crypto.js';
import { OAuthError, safeError } from './errors.js';
import { refreshLocked } from './refresh.js';
import type { PostgresTokenStore } from './store.js';
import type { AuthorizationSnapshot, Provider, ProviderAdapter, ServiceOptions, TokenSet } from './types.js';
export class OAuthService {
    private readonly providers = new Map<Provider, ProviderAdapter>();
    private readonly now: () => number;
    private readonly ttl: number;
    constructor(private readonly store: PostgresTokenStore, providers: ProviderAdapter[], private readonly options: ServiceOptions = {}) {
        this.now = options.now ?? Date.now;
        this.ttl = options.stateTtlMs ?? 600000;
        if (!Number.isFinite(this.ttl) || this.ttl <= 0 || this.ttl > 600000)
            throw new OAuthError('CONFIG_INVALID');
        for (const provider of providers) {
            if (this.providers.has(provider.provider))
                throw new OAuthError('CONFIG_INVALID');
            this.providers.set(provider.provider, provider);
        }
    }
    private adapter(provider: Provider): ProviderAdapter { const result = this.providers.get(provider); if (!result)
        throw new OAuthError('CONFIG_INVALID'); return result; }
    private async observe<T>(operation: 'start' | 'callback' | 'refresh' | 'revoke', work: () => Promise<T>): Promise<T> {
        const log = (outcome: 'ok' | 'error', code?: string) => { try {
            this.options.logger?.({ operation, outcome, ...(code ? { code } : {}) });
        }
        catch { /* Telemetry cannot affect credential state. */ } };
        try {
            const result = await work();
            log('ok');
            return result;
        }
        catch (error) {
            const safe = safeError(error);
            log('error', safe.code);
            throw safe;
        }
    }
    async start(provider: Provider, tenantId: string, scopes: string[]): Promise<{
        authUrl: string;
        state: string;
    }> {
        return this.observe('start', async () => {
            const adapter = this.adapter(provider);
            if (!tenantId || tenantId.length > 1024 || scopes.some(s => !s || /[\s,]/.test(s)))
                throw new OAuthError('CONFIG_INVALID');
            const state = randomBytes(32).toString('base64url');
            const verifier = randomBytes(32).toString('base64url');
            const authUrl = adapter.authorize(state, pkceChallenge(verifier), scopes);
            await this.store.withLock(tenantId, provider, client => this.store.createState(client, state, { tenantId, provider, scopes: [...scopes], redirectUri: adapter.redirectUri, verifier, binding: adapter.binding }, new Date(this.now() + this.ttl)));
            return { authUrl, state };
        });
    }
    async callback(code: string, state: string): Promise<TokenSet> {
        return this.observe('callback', async () => {
            const owner = await this.store.peekState(state);
            return this.store.withLock(owner.tenantId, owner.provider, async (client) => {
                const pending = await this.store.consumeState(client, state, this.now());
                const adapter = this.adapter(pending.provider);
                if (pending.binding !== adapter.binding || pending.redirectUri !== adapter.redirectUri || pending.tenantId !== owner.tenantId || pending.provider !== owner.provider || !code)
                    throw new OAuthError('STATE_INVALID');
                const token = await adapter.exchange(code, pending.verifier, pending.scopes, this.now());
                // A new authorization never inherits a previous account's refresh token or scopes.
                await this.store.write(client, pending.tenantId, pending.provider, token, adapter.binding);
                return token;
            });
        });
    }
    async getAccessToken(tenantId: string, provider: Provider): Promise<string> { return (await this.getAuthorizationSnapshot(tenantId, provider)).accessToken; }
    /** Call once after a resource 401, then retry that resource operation at most once.
     * Passing the actual rejected access token coalesces stale 401s across instances. */
    async refreshAfterUnauthorized(tenantId: string, provider: Provider, rejectedAccessToken: string): Promise<string> { return (await this.getAuthorizationSnapshot(tenantId, provider, rejectedAccessToken)).accessToken; }
    async getAuthorizationSnapshot(tenant: string, provider: Provider, rejectedAccessToken?: string): Promise<AuthorizationSnapshot> {
        return this.observe('refresh', () => this.store.withLock(tenant, provider, async (client) => {
            const adapter = this.adapter(provider);
            const stored = await this.store.read(client, tenant, provider);
            if (!stored || stored.status === 'revoked' || !stored.token)
                throw new OAuthError('NOT_CONNECTED');
            if (stored.status === 'reconsent')
                throw new OAuthError('RECONSENT_REQUIRED');
            const token = stored.token;
            if (token.identity !== adapter.identity || stored.binding !== adapter.binding)
                throw new OAuthError('IDENTITY_MISMATCH');
            const force = rejectedAccessToken !== undefined && rejectedAccessToken === token.accessToken;
            const expiring = token.expiresAt !== null && token.expiresAt.getTime() - this.now() < 60000;
            const current = force || expiring ? await refreshLocked(this.store, client, tenant, adapter, token, this.now()) : token;
            return { accessToken: current.accessToken, scopes: [...current.scopes], identity: current.identity, expiresAt: current.expiresAt };
        }));
    }
    async revoke(tenantId: string, provider: Provider): Promise<void> {
        return this.observe('revoke', () => this.store.withLock(tenantId, provider, async (client) => {
            const adapter = this.adapter(provider);
            const stored = await this.store.read(client, tenantId, provider);
            await this.store.cancelStates(client, tenantId, provider);
            await this.store.mark(client, tenantId, provider, 'revoked');
            if (!stored?.token)
                return;
            if (stored.token.identity !== adapter.identity || stored.binding !== adapter.binding)
                throw new OAuthError('IDENTITY_MISMATCH');
            try {
                let token = stored.token;
                // GitHub grant deletion requires a valid access token. Local denial is
                // already committed and must remain revoked while rotating for deletion.
                if (provider === 'github' && token.expiresAt !== null && token.expiresAt.getTime() - this.now() < 60000) {
                    if (!token.refreshToken) throw new OAuthError('REVOKE_FAILED');
                    token = await adapter.refresh(token, this.now());
                    await this.store.write(client, tenantId, provider, token, adapter.binding, 'revoked');
                }
                await adapter.revoke(token);
            }
            catch {
                throw new OAuthError('REVOKE_FAILED');
            }
            await this.store.mark(client, tenantId, provider, 'revoked', true);
        }));
    }
}
