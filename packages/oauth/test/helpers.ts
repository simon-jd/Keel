import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { TokenCipher } from '../src/crypto.js';
import { PostgresTokenStore } from '../src/store.js';
import { OAuthService } from '../src/flow.js';
import { slack, github, google, salesforce } from '../src/providers/index.js';
import type { ServiceOptions } from '../src/types.js';
export interface Request { path: string; method: string; body: URLSearchParams; raw: string; headers: IncomingMessage['headers'] }
export async function harness() {
  const container = await new PostgreSqlContainer('pgvector/pgvector:0.8.1-pg17').withLabels({ project: 'keel', purpose: 'oauth-tests' }).withResourcesQuota({ memory: 512 * 1024 * 1024, cpu: 1 }).start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 16, connectionTimeoutMillis: 3000 });
  const pool2 = new Pool({ connectionString: container.getConnectionUri(), max: 16, connectionTimeoutMillis: 3000 });
  const dir = await mkdtemp(join(tmpdir(), 'keel-oauth-'));
  await writeFile(join(dir, 'key'), randomBytes(32), { mode: 0o600 });
  const cipher = await TokenCipher.fromKeyFile(join(dir, 'key'));
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(n => n.endsWith('.up.sql')).sort()) await pool.query(await readFile(new URL(name, migrations), 'utf8'));
  const requests: Request[] = []; const failures: unknown[] = [];
  let handle = (_request: Request, response: ServerResponse) => { response.end(JSON.stringify({ access_token: 'access-original', refresh_token: 'refresh-original', expires_in: 3600, scope: 'read write', token_type: 'Bearer' })); };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const request = { path: req.url!, method: req.method!, headers: req.headers, raw, body: new URLSearchParams(raw) };
    requests.push(request); res.setHeader('Content-Type', 'application/json');
    try { await handle(request, res); } catch (error) { failures.push(error); res.statusCode=500; res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  const origin = `http://127.0.0.1:${address.port}`;
  const config = (provider: string) => ({ clientId: 'client', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1/callback', timeoutMs: 300, endpoints: { authorize: `${origin}/${provider}/authorize`, token: `${origin}/${provider}/token`, revoke: `${origin}/${provider}/revoke` } });
  const providers = () => [slack({ ...config('slack'), tokenKind: 'user' }), github(config('github')), google(config('google')), salesforce({ ...config('salesforce'), loginOrigin: 'https://example-dev-ed.my.salesforce.com' })];
  return { pool, pool2, cipher, requests, failures, config, origin,
    respond(fn: typeof handle) { handle = fn; },
    service(options: ServiceOptions = {}, second = false) { return new OAuthService(new PostgresTokenStore(second ? pool2 : pool, cipher), providers(), options); },
    async cleanup() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); await pool2.end(); await container.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}
