import type { DatabaseSession } from './session.js';
import { OAuthError } from './errors.js';
import type { PostgresTokenStore } from './store.js';
import type { ProviderAdapter, TokenSet } from './types.js';
export async function refreshLocked(store: PostgresTokenStore, client: DatabaseSession, tenant: string, adapter: ProviderAdapter, previous: TokenSet, now: number): Promise<TokenSet> {
    if (previous.refreshToken === null) {
        await store.mark(client, tenant, adapter.provider, 'reconsent');
        throw new OAuthError('RECONSENT_REQUIRED');
    }
    try {
        const next = await adapter.refresh(previous, now);
        await store.write(client, tenant, adapter.provider, next, adapter.binding);
        return next;
    }
    catch (error) {
        if (error instanceof OAuthError && (error.code === 'INVALID_GRANT' || error.code === 'PROVIDER_INVALID')) {
            await store.mark(client, tenant, adapter.provider, 'reconsent');
            throw new OAuthError('RECONSENT_REQUIRED');
        }
        throw error;
    }
}
