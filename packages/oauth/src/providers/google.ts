import { OAuthError } from '../errors.js';
import type { ClientConfig, ProviderAdapter } from '../types.js';
import { adapter, parseToken } from './common.js';
export function google(config: ClientConfig & {
    clientType?: 'web' | 'desktop';
}): ProviderAdapter {
    const clientType = config.clientType ?? 'web';
    if (clientType === 'web' && !config.clientSecret)
        throw new OAuthError('CONFIG_INVALID');
    return adapter(config, { provider: 'google', identity: 'google-user', bindingContext: clientType, defaults: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' },
        authorize(params, scopes) { params.set('scope', scopes.join(' ')); params.set('access_type', 'offline'); if (clientType === 'web')
            params.set('include_granted_scopes', 'true'); },
        parse(data, _refreshing, scopes, refresh, now) { return parseToken(data, 'google-user', scopes, refresh, now); },
    });
}
