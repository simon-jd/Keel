import { OAuthError } from '../errors.js';
import type { ClientConfig, ProviderAdapter } from '../types.js';
import { adapter, parseToken } from './common.js';
export function salesforce(config: ClientConfig & {
    loginOrigin: string;
}): ProviderAdapter {
    let origin: string;
    try {
        const url = new URL(config.loginOrigin);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !(['login.salesforce.com', 'test.salesforce.com'].includes(url.hostname) || url.hostname.endsWith('.my.salesforce.com')))
            throw new Error();
        origin = url.origin;
    }
    catch {
        throw new OAuthError('CONFIG_INVALID');
    }
    return adapter(config, { provider: 'salesforce', identity: 'salesforce-user', defaults: { authorize: `${origin}/services/oauth2/authorize`, token: `${origin}/services/oauth2/token`, revoke: `${origin}/services/oauth2/revoke` },
        authorize(params, scopes) { params.set('scope', scopes.join(' ')); },
        parse(data, _refreshing, scopes, refresh, now) { return parseToken(data, 'salesforce-user', scopes, refresh, now); },
    });
}
