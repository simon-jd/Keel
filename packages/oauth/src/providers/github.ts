import { OAuthError } from '../errors.js';
import type { ClientConfig, ProviderAdapter } from '../types.js';
import { adapter, parseToken } from './common.js';
/** GitHub App USER OAuth. Installation JWT/token exchange belongs to the MCP integration. */
export function github(config: ClientConfig): ProviderAdapter {
    return adapter(config, { provider: 'github', identity: 'github-app-user', revoke: 'github', defaults: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', revoke: `https://api.github.com/applications/${encodeURIComponent(config.clientId)}/grant` },
        authorize(params, scopes) { if (scopes.some(scope => scope !== 'offline_access'))
            throw new OAuthError('CONFIG_INVALID'); if (scopes.length)
            params.set('scope', 'offline_access'); },
        parse(data, refreshing, _scopes, refresh, now) {
            if (refreshing && typeof data.refresh_token !== 'string')
                throw new OAuthError('PROVIDER_INVALID');
            // App permissions are registered separately, never inferred from OAuth scope or token prefix.
            const result = parseToken(data, 'github-app-user', [], refresh, now);
            result.scopes = [];
            return result;
        },
    });
}
