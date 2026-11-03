import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { harness } from './helpers.js';
import { PostgresTokenStore } from '../src/store.js';
import { OAuthService } from '../src/flow.js';
import { google } from '../src/providers/index.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h?.cleanup(); });
const safeOutcome = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => error);

// A real ACCESS EXCLUSIVE lock must not leave callback's state SELECT waiting indefinitely.
test('callback state lookup has a server and client deadline', async () => {
  const started = await h.service().start('google', 'blocked-state-tenant', ['read']);
  const locker = await h.pool2.connect();
  await locker.query('BEGIN'); await locker.query('LOCK TABLE oauth_states IN ACCESS EXCLUSIVE MODE');
  const logs: unknown[] = [];
  const service = new OAuthService(new PostgresTokenStore(h.pool, h.cipher, { timeoutMs: 100 }), [google(h.config('google'))], { logger: event => logs.push(event) });
  const requestCount = h.requests.length;
  const result = safeOutcome(service.callback('sensitive-code', started.state));
  try {
    const outcome = await Promise.race([result, delay(600, 'deadline-missed')]);
    expect(outcome).toMatchObject({ code: 'STORE_ERROR' });
    expect(JSON.stringify({ outcome, logs })).not.toContain('blocked-state-tenant');
    expect(JSON.stringify({ outcome, logs })).not.toContain('sensitive-code');
    expect(h.requests).toHaveLength(requestCount);
    await delay(120);
    const waiting = await h.pool2.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE 'SELECT tenant_id, provider FROM oauth_states%'");
    expect(waiting.rows).toEqual([{ n: 0 }]);
  } finally { await locker.query('ROLLBACK'); locker.release(); await result; }
});

// A timed-out pool queue entry must never run its SQL once a connection eventually arrives.
test('late acquired connections are destroyed without executing the abandoned request', async () => {
  const pool = new Pool({ connectionString: h.pool.options.connectionString, max: 1, connectionTimeoutMillis: 2000 });
  const held = await pool.connect(); const statements: string[] = [];
  const query = held.query.bind(held);
  held.query = ((...args: Parameters<typeof held.query>) => { statements.push(String(args[0])); return query(...args); }) as typeof held.query;
  const store = new PostgresTokenStore(pool, h.cipher, { timeoutMs: 100 });
  const result = safeOutcome(store.peekState('late-state')); let remaining: number | undefined;
  try {
    const outcome = await Promise.race([result, delay(500, 'deadline-missed')]);
    expect(outcome).toMatchObject({ code: 'STORE_ERROR' });
  } finally { held.release(); await result; await delay(100); remaining = pool.totalCount; await pool.end(); }
  expect(statements).toEqual([]); expect(remaining).toBe(0);
});

async function blackhole(trigger: string) {
  const destination = new URL(h.pool.options.connectionString!);
  const upstream = { host: destination.hostname, port: Number(destination.port) };
  const sockets = new Set<Socket>(); let dropped = false; let clientClosed = false;
  const server = createServer(front => {
    const back = connect(upstream);
    front.setNoDelay(true); back.setNoDelay(true);
    sockets.add(front); sockets.add(back);
    let frozen = false;
    front.on('data', data => { if (data.includes(Buffer.from(trigger))) { frozen = true; dropped = true; } back.write(data); });
    back.on('data', data => { if (!frozen) front.write(data); });
    front.on('error', () => {}); back.on('error', () => {});
    front.on('close', () => { clientClosed = true; back.destroy(); sockets.delete(front); });
    back.on('close', () => { front.destroy(); sockets.delete(back); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('proxy failed');
  destination.hostname = '127.0.0.1'; destination.port = String(address.port);
  const pool = new Pool({ connectionString: destination.href, max: 1, connectionTimeoutMillis: 2000 });
  // Deliberate transport cuts can emit out-of-band pg errors as well as query rejections.
  pool.on('connect', client => client.on('error', () => {}));
  pool.on('error', () => {});
  return { pool, dropped: () => dropped, closed: () => clientClosed,
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() { for (const socket of sockets) socket.destroy(); await pool.end(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

// Dropped server replies defeat statement_timeout alone; the local deadline must destroy the socket.
test.each(['SET statement_timeout', 'SELECT tenant_id', 'pg_advisory_unlock', 'RESET statement_timeout'])('lost reply at %s destroys the client within the deadline', async trigger => {
  const proxy = await blackhole(trigger);
  const store = new PostgresTokenStore(proxy.pool, h.cipher, { timeoutMs: 100 });
  let fallback: ReturnType<typeof setTimeout> | undefined;
  try {
    const warm = await proxy.pool.connect(); warm.release();
    fallback = setTimeout(() => proxy.disconnect(), 1200);
    const before = performance.now();
    const result = trigger === 'SELECT tenant_id' ? store.peekState('missing') : store.withLock('proxy-tenant', 'google', async () => 42);
    const outcome = await safeOutcome(result);
    expect(proxy.dropped()).toBe(true);
    expect(outcome).toMatchObject({ code: 'STORE_ERROR' });
    expect(performance.now() - before).toBeLessThan(800);
    await delay(40); expect(proxy.closed()).toBe(true);
    expect(proxy.pool.totalCount).toBe(0);
    // A different physical pool can obtain the same lock after the broken connection was destroyed.
    await new PostgresTokenStore(h.pool2, h.cipher, { timeoutMs: 200 }).withLock('proxy-tenant', 'google', async () => {});
  } finally { clearTimeout(fallback); await proxy.close(); }
});
