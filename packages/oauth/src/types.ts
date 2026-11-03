export type Provider = 'slack' | 'github' | 'google' | 'salesforce';
export type Identity = 'slack-user' | 'slack-bot' | 'github-app-user' | 'google-user' | 'salesforce-user';
export interface TokenSet {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
    scopes: string[];
    identity: Identity;
}
export type AuthorizationSnapshot = Omit<TokenSet, 'refreshToken'>;
export interface ClientConfig {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    endpoints?: {
        authorize: string;
        token: string;
        revoke: string;
    };
    timeoutMs?: number;
}
export interface PendingState {
    tenantId: string;
    provider: Provider;
    scopes: string[];
    redirectUri: string;
    verifier: string;
    binding: string;
}
export interface ProviderAdapter {
    readonly provider: Provider;
    readonly identity: Identity;
    readonly redirectUri: string;
    readonly binding: string;
    authorize(state: string, challenge: string, scopes: string[]): string;
    exchange(code: string, verifier: string, scopes: string[], now: number): Promise<TokenSet>;
    refresh(previous: TokenSet, now: number): Promise<TokenSet>;
    revoke(token: TokenSet): Promise<void>;
}
export interface ServiceOptions {
    now?: () => number;
    stateTtlMs?: number;
    logger?: (event: {
        operation: 'start' | 'callback' | 'refresh' | 'revoke';
        outcome: 'ok' | 'error';
        code?: string;
    }) => void;
}
