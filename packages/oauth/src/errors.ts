export type ErrorCode = 'KEY_INVALID' | 'CIPHER_INVALID' | 'STATE_INVALID' | 'CONFIG_INVALID' | 'PROVIDER_ERROR' | 'PROVIDER_INVALID' | 'INVALID_GRANT' | 'RECONSENT_REQUIRED' | 'NOT_CONNECTED' | 'IDENTITY_MISMATCH' | 'STORE_ERROR' | 'REVOKE_FAILED';
export class OAuthError extends Error {
    constructor(readonly code: ErrorCode) { super(code); this.name = 'OAuthError'; }
}
export function safeError(error: unknown): OAuthError { return error instanceof OAuthError ? error : new OAuthError('STORE_ERROR'); }
