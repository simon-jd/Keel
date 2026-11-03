import { createHash } from 'node:crypto';
import { OAuthError } from '../errors.js';
import type { ClientConfig, Identity, Provider, ProviderAdapter, TokenSet } from '../types.js';
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new OAuthError('PROVIDER_INVALID');
    return value as Json;
}
function endpoint(value: string): string {
    try {
        const url = new URL(value);
        if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))))
            throw new Error();
        return url.href;
    }
    catch {
        throw new OAuthError('CONFIG_INVALID');
    }
}
export function parseToken(data: Json, identity: Identity, fallbackScopes: string[], previousRefresh: string | null, now: number): TokenSet {
    if (typeof data.access_token !== 'string' || !data.access_token)
        throw new OAuthError('PROVIDER_INVALID');
    if (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token))
        throw new OAuthError('PROVIDER_INVALID');
    if (data.scope !== undefined && typeof data.scope !== 'string')
        throw new OAuthError('PROVIDER_INVALID');
    let expiresAt: Date | null = null;
    if (data.expires_in !== undefined) {
        if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31536000)
            throw new OAuthError('PROVIDER_INVALID');
        expiresAt = new Date(now + data.expires_in * 1000);
    }
    return { accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : previousRefresh, expiresAt,
        scopes: typeof data.scope === 'string' ? [...new Set(data.scope.split(/[ ,]+/).filter(Boolean))] : [...fallbackScopes], identity };
}
export interface Protocol {
    provider: Provider;
    identity: Identity;
    defaults: NonNullable<ClientConfig['endpoints']>;
    authorize(params: URLSearchParams, scopes: string[]): void;
    parse(data: Json, refreshing: boolean, scopes: string[], refresh: string | null, now: number): TokenSet;
    revoke?: 'github' | 'slack';
    bindingContext?: string;
    omitExchangeSecret?: boolean;
    omitRefreshSecret?: boolean;
}
/** Native fetch has no HTTP tracing instrumentation in this package. Never pass bodies to telemetry. */
export function adapter(config: ClientConfig, protocol: Protocol): ProviderAdapter {
    if (!config.clientId || (protocol.provider === 'github' && !config.clientSecret))
        throw new OAuthError('CONFIG_INVALID');
    const endpoints = config.endpoints ?? protocol.defaults;
    const urls = { authorize: endpoint(endpoints.authorize), token: endpoint(endpoints.token), revoke: endpoint(endpoints.revoke) };
    const redirectUri = endpoint(config.redirectUri);
    const timeout = config.timeoutMs ?? 10000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 10000)
        throw new OAuthError('CONFIG_INVALID');
    const credentials = () => new URLSearchParams({ client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) });
    const binding = createHash('sha256').update(JSON.stringify([protocol.provider, protocol.identity, config.clientId, redirectUri, urls, protocol.bindingContext])).digest('hex');
    async function request(url: string, body: URLSearchParams | string, revoke = false): Promise<Json> {
        try {
            const github = revoke && protocol.revoke === 'github';
            const response = await fetch(url, { method: github ? 'DELETE' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout), headers: {
                    Accept: github ? 'application/vnd.github+json' : 'application/json', 'Content-Type': github ? 'application/json' : 'application/x-www-form-urlencoded',
                    ...(github ? { Authorization: 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64'), 'X-GitHub-Api-Version': '2026-03-10' } : {}),
                }, body });
            // Bound the entire stream, including malicious or stalled error responses.
            const chunks: Uint8Array[] = [];
            let length = 0;
            if (response.body) {
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const next = await reader.read();
                        if (next.done)
                            break;
                        length += next.value.length;
                        if (length > 65536) {
                            await reader.cancel();
                            throw new OAuthError('PROVIDER_INVALID');
                        }
                        chunks.push(next.value);
                    }
                }
                finally {
                    reader.releaseLock();
                }
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (revoke && protocol.revoke !== 'slack') {
                if (!response.ok)
                    throw new OAuthError('PROVIDER_ERROR');
                return {};
            }
            const data = object(JSON.parse(text));
            if (data.error !== undefined || data.ok === false) {
                if (['invalid_grant', 'invalid_refresh_token', 'bad_refresh_token'].includes(String(data.error)))
                    throw new OAuthError('INVALID_GRANT');
                throw new OAuthError('PROVIDER_ERROR');
            }
            if (!response.ok)
                throw new OAuthError('PROVIDER_ERROR');
            if (protocol.provider === 'slack' && data.ok !== true)
                throw new OAuthError('PROVIDER_INVALID');
            return data;
        }
        catch (error) {
            if (error instanceof OAuthError)
                throw error;
            throw new OAuthError('PROVIDER_ERROR');
        }
    }
    return { provider: protocol.provider, identity: protocol.identity, redirectUri, binding,
        authorize(state, challenge, scopes) {
            const url = new URL(urls.authorize);
            const params = url.searchParams;
            params.set('client_id', config.clientId);
            params.set('response_type', 'code');
            params.set('redirect_uri', redirectUri);
            params.set('state', state);
            params.set('code_challenge', challenge);
            params.set('code_challenge_method', 'S256');
            protocol.authorize(params, scopes);
            return url.href;
        },
        async exchange(code, verifier, scopes, now) {
            const body = credentials();
            if (protocol.omitExchangeSecret)
                body.delete('client_secret');
            body.set('grant_type', 'authorization_code');
            body.set('code', code);
            body.set('code_verifier', verifier);
            body.set('redirect_uri', redirectUri);
            return protocol.parse(await request(urls.token, body), false, scopes, null, now);
        },
        async refresh(previous, now) {
            if (!previous.refreshToken)
                throw new OAuthError('INVALID_GRANT');
            const body = credentials();
            if (protocol.omitRefreshSecret)
                body.delete('client_secret');
            body.set('grant_type', 'refresh_token');
            body.set('refresh_token', previous.refreshToken);
            return protocol.parse(await request(urls.token, body), true, previous.scopes, previous.refreshToken, now);
        },
        async revoke(token) {
            const body = protocol.revoke === 'github' ? JSON.stringify({ access_token: token.accessToken }) : new URLSearchParams({ token: protocol.revoke === 'slack' ? token.accessToken : token.refreshToken ?? token.accessToken });
            const data = await request(urls.revoke, body, true);
            if (protocol.revoke === 'slack' && data.revoked !== true)
                throw new OAuthError('PROVIDER_ERROR');
        },
    };
}
