import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { OAuthError } from './errors.js';

/** Destroy the transport before removing it from the pool, including pipelined clients.
 * pg.release(true) alone can gracefully wait for pipelined queries to drain. */
function discard(client: PoolClient): void {
    client.on('error', () => {});
    client.connection.stream.destroy();
    client.release(true);
}

/** Every query, including session setup and cleanup, owns a local deadline.
 * Timed-out clients are destroyed, never returned to the pool for another caller. */
export class DatabaseSession {
    private closed = false;
    private readonly onError = () => this.destroy();
    constructor(private readonly client: PoolClient, private readonly timeoutMs: number) {
        client.on('error', this.onError);
    }
    get destroyed(): boolean { return this.closed; }
    destroy(): void {
        if (this.closed) return;
        this.closed = true;
        this.client.removeListener('error', this.onError);
        discard(this.client);
    }
    query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
        if (this.closed) return Promise.reject(new OAuthError('STORE_ERROR'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.destroy();
                reject(new OAuthError('STORE_ERROR'));
            }, this.timeoutMs);
            Promise.resolve().then(() => this.client.query<R>(sql, values)).then(result => {
                clearTimeout(timer);
                if (this.closed) reject(new OAuthError('STORE_ERROR'));
                else resolve(result);
            }, () => {
                clearTimeout(timer);
                this.destroy();
                reject(new OAuthError('STORE_ERROR'));
            });
        });
    }
    async release(): Promise<void> {
        if (this.closed) return;
        await this.query('RESET statement_timeout');
        this.closed = true;
        this.client.removeListener('error', this.onError);
        this.client.release();
    }
}

export function acquire(pool: Pool, timeoutMs: number): Promise<DatabaseSession> {
    return new Promise((resolve, reject) => {
        let expired = false;
        const timer = setTimeout(() => { expired = true; reject(new OAuthError('STORE_ERROR')); }, timeoutMs);
        pool.connect().then(client => {
            clearTimeout(timer);
            if (expired) discard(client);
            else resolve(new DatabaseSession(client, timeoutMs));
        }, () => {
            clearTimeout(timer);
            reject(new OAuthError('STORE_ERROR'));
        });
    });
}
