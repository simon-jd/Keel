import { OAuthError } from '../errors.js';
import type { ClientConfig, ProviderAdapter } from '../types.js';
import { adapter, object, parseToken } from './common.js';
export function slack(config: ClientConfig & {
    tokenKind?: 'user' | 'bot';
}): ProviderAdapter {
    const kind = config.tokenKind ?? 'user';
    const identity = kind === 'user' ? 'slack-user' : 'slack-bot';
    let desktop: boolean;
    try {
        desktop = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.redirectUri).hostname);
    }
    catch {
        throw new OAuthError('CONFIG_INVALID');
    }
    if (kind === 'bot' && desktop)
        throw new OAuthError('CONFIG_INVALID');
    return adapter(config, { provider: 'slack', identity, revoke: 'slack', omitExchangeSecret: true, omitRefreshSecret: desktop, defaults: { authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access', revoke: 'https://slack.com/api/auth.revoke' },
        authorize(params, scopes) { params.set(kind === 'user' ? 'user_scope' : 'scope', scopes.join(',')); },
        parse(data, refreshing, scopes, refresh, now) {
            const selected = kind === 'user' && !refreshing ? object(data.authed_user) : data;
            if (refreshing && typeof selected.refresh_token !== 'string')
                throw new OAuthError('PROVIDER_INVALID');
            if (selected.token_type !== kind)
                throw new OAuthError('PROVIDER_INVALID');
            return parseToken(selected, identity, scopes, refresh, now);
        },
    });
}
