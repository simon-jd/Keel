import { trustedUrl } from './http.js';
import { verify, type KeyObject } from 'node:crypto';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
export interface AuthConfig { issuer: string; resource: string; publicKey: KeyObject; subjects: Readonly<Record<string, string>> }
/** Pinned, operator-configured AS key. No jku/x5u fetches or token-provided tenant routing. */
export class JwtVerifier {
  private readonly subjects: Readonly<Record<string,string>>;
  constructor(private readonly config: AuthConfig) {
    if (config.publicKey.type !== 'public' || config.publicKey.asymmetricKeyType !== 'rsa' || (config.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw Error('AUTH_CONFIG_INVALID');
    try { trustedUrl(config.issuer); trustedUrl(config.resource); if (!Object.keys(config.subjects).length || Object.values(config.subjects).some(value => typeof value !== 'string' || !value || value.length > 256)) throw Error(); } catch { throw Error('AUTH_CONFIG_INVALID'); }
    this.subjects = { ...config.subjects };
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
      const [h,p,s] = token.split('.') as [string,string,string];
      const header = JSON.parse(Buffer.from(h,'base64url').toString()) as Record<string,unknown>;
      if (header.alg !== 'RS256' || (header.typ !== 'at+jwt' && header.typ !== 'JWT') || header.crit !== undefined || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), this.config.publicKey, Buffer.from(s,'base64url'))) throw Error();
      const claims = JSON.parse(Buffer.from(p,'base64url').toString()) as Record<string,unknown>;
      const now = Date.now()/1000;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const tenantId = typeof claims.sub === 'string' && Object.hasOwn(this.subjects,claims.sub) ? this.subjects[claims.sub] : undefined;
      if (claims.iss !== this.config.issuer || !audiences.includes(this.config.resource) || !tenantId || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now)) || typeof claims.scope !== 'string' || typeof claims.client_id !== 'string' || !claims.client_id) throw Error();
      return { token, clientId: claims.client_id, scopes: claims.scope.split(' ').filter(Boolean), expiresAt: claims.exp, resource: new URL(this.config.resource), extra: { tenantId, subject: claims.sub } };
    } catch { throw new OAuthError(OAuthErrorCode.InvalidToken,'Invalid token'); }
  }
}
