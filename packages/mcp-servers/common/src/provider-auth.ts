import { OAuthError, type OAuthService, type Provider, type Identity, type AuthorizationSnapshot } from 'oauth';
/** One alternative group per required capability; the first entry is the least grant requested. */
export type Capabilities = readonly (readonly string[])[];
export interface ConsentRequest {
    tenantId: string;
    provider: Provider;
    scopes: string[];
    authUrl: string;
    state: string;
}
/** Trusted host control-plane callback. Never forward this object into model messages or traces. */
export type ConsentHandler = (request: ConsentRequest) => Promise<void>;
export class MissingScopeError extends Error {
    constructor(readonly requiredScopes: string[]) {
        super('SCOPE_MISSING');
    }
}
export function providerAuthorization(oauth: OAuthService, provider: Provider, identity: Identity, onConsentRequired?: ConsentHandler) {
    async function missing(tenantId: string, scopes: string[]): Promise<never> {
        if (onConsentRequired) {
            try {
                const pending = await oauth.start(provider, tenantId, scopes);
                await onConsentRequired({
                    tenantId, provider, scopes: [...scopes], ...pending
                });
            }
            catch { /* Consent delivery failure never grants a capability or leaks control-plane details. */
            }
        }
        throw new MissingScopeError(scopes);
    }
    async function snapshot(tenant: string, capabilities: Capabilities, rejected?: string): Promise<AuthorizationSnapshot> {
        let current: AuthorizationSnapshot;
        try {
            current = await oauth.getAuthorizationSnapshot(tenant, provider, rejected);
        }
        catch (error) {
            if (error instanceof OAuthError && ['NOT_CONNECTED', 'RECONSENT_REQUIRED'].includes(error.code)) {
                return missing(tenant, capabilities.map(group => group[0]!));
            }
            throw error;
        }
        if (current.identity !== identity)
            throw Error('IDENTITY_MISMATCH');
        const needed = capabilities.filter(group => !group.some(scope => current.scopes.includes(scope))).map(group => group[0]!);
        if (needed.length)
            return missing(tenant, needed);
        return current;
    }
    return async function authorized(tenant: string, capabilities: Capabilities, signal: AbortSignal, operation: (token: string) => Promise<{
        status: number;
        data: unknown;
    }>): Promise<unknown> {
        let current = await snapshot(tenant, capabilities);
        for (let attempt = 0; attempt < 2; attempt++) {
            signal.throwIfAborted();
            const response = await operation(current.accessToken);
            if (response.status === 401 && attempt === 0) {
                current = await snapshot(tenant, capabilities, current.accessToken);
                continue;
            }
            if (response.status < 200 || response.status >= 300)
                throw Error('PROVIDER_REJECTED');
            return response.data;
        }
        throw Error('PROVIDER_REJECTED');
    };
}
