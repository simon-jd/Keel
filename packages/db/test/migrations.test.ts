import { readdir, readFile } from 'node:fs/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { externalDatabase } from '../../runtime/test/externalDatabase.js';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { actions, runs, steps } from '../schema.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

let container: { getConnectionUri: () => string; stop: () => Promise<unknown> } | undefined;
let client: Client | undefined;
const migrationDirectory = new URL('../migrations/', import.meta.url);

beforeAll(async () => {
  container = await externalDatabase() ?? await new PostgreSqlContainer('pgvector/pgvector:0.8.1-pg17').withLabels({ project: 'keel', purpose: 'db-tests' }).withResourcesQuota({ memory: 512 * 1024 * 1024, cpu: 1 }).start();
  client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
});

afterAll(async () => {
  try {
    await client?.end();
  } finally {
    await container?.stop();
  }
});

async function applyMigrations(direction: 'up' | 'down'): Promise<void> {
  if (!client) throw new Error('Postgres client was not started');
  const files = (await readdir(migrationDirectory)).filter((name) => name.endsWith(`.${direction}.sql`)).sort();
  if (direction === 'down') files.reverse();
  for (const name of files) await client.query(await readFile(new URL(name, migrationDirectory), 'utf8'));
}

// Catches missing tables, incomplete down migrations, and objects left behind by rollback.
test('migrations apply and roll back cleanly', async () => {
  if (!client) throw new Error('Postgres client was not started');
  await applyMigrations('up');
  const tables = await client.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  expect(tables.rows.map(({ name }) => name)).toEqual(['actions', 'chunks', 'mcp_actions', 'oauth_states', 'rag_corpora', 'rag_embedding_profiles', 'runs', 'steps', 'token_store']);

  await applyMigrations('down');
  const remainingObjects = await client.query<{ name: string }>(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
    UNION ALL
    SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
    UNION ALL
    SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
  `);
  expect(remainingObjects.rows).toEqual([]);
});

describe('migrated database', () => {
  beforeEach(async () => { await applyMigrations('up'); });
  afterEach(async () => { await applyMigrations('down'); });

  // Catches missing UUID/JSON/timestamp mappings and loss of persistent run/step/action data.
  test('persists complete run, step, and action records with generated timestamps', async () => {
    if (!client) throw new Error('Postgres client was not started');
    const id = '10000000-0000-4000-8000-000000000001';
    const db = drizzle(client);
    await db.insert(runs).values({ id, tenantId: 'tenant-a', status: 'RUNNING', budgetJson: { usd: 1 } });
    const run = await client.query('SELECT * FROM runs WHERE id = $1', [id]);
    expect(run.rows[0]).toMatchObject({ id, tenant_id: 'tenant-a', status: 'RUNNING', budget_json: { usd: 1 } });
    expect(run.rows[0].created_at).toBeInstanceOf(Date);
    await db.insert(steps).values({ runId: id, seq: 0, kind: 'tool', payloadJson: { prompt: 'test' }, status: 'PENDING' });
    expect(await db.select().from(steps).where(eq(steps.runId, id))).toEqual([
      { runId: id, seq: 0, kind: 'tool', payloadJson: { prompt: 'test' }, status: 'PENDING' },
    ]);
    await db.insert(actions).values({ actionKey: 'action-1', runId: id, tool: 'calendar.read', argsHash: 'hash-1' });
    const action = await client.query("SELECT * FROM actions WHERE action_key = 'action-1'");
    expect(action.rows[0]).toMatchObject({ action_key: 'action-1', run_id: id, status: 'PENDING', result_json: null });
    expect(action.rows[0].updated_at).toBeInstanceOf(Date);
    const otherRuns = await db.insert(runs).values({ tenantId: 'tenant-b', status: 'RUNNING', budgetJson: {} }).returning();
    const otherRun = otherRuns[0];
    expect(otherRun?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    if (!otherRun) throw new Error('Run insert did not return a record');
    await db.insert(steps).values({ runId: otherRun.id, seq: 0, kind: 'tool', payloadJson: {}, status: 'PENDING' });
    expect((await db.select().from(steps)).length).toBe(2);
    for (const status of ['SUCCEEDED', 'FAILED', 'UNKNOWN']) {
      const result = await client.query(
        `UPDATE actions SET status = $1, result_json = '{"ok":true}', updated_at = now()
         WHERE action_key = 'action-1' RETURNING status, result_json`, [status],
      );
      expect(result.rows).toEqual([{ status, result_json: { ok: true } }]);
    }
  });

  // Catches missing foreign keys, duplicate step/action identities, and invalid action status acceptance.
  test('rejects orphan records, duplicate identities, invalid action statuses, and missing required data', async () => {
    if (!client) throw new Error('Postgres client was not started');
    const id = '10000000-0000-4000-8000-000000000001';
    const missingId = '10000000-0000-4000-8000-000000000002';
    await client.query(
      `INSERT INTO runs (id, tenant_id, status, budget_json) VALUES ($1, 'tenant-a', 'RUNNING', '{}')`, [id],
    );
    await client.query(`INSERT INTO steps VALUES ($1, 0, 'tool', '{}', 'PENDING')`, [id]);
    await client.query(
      `INSERT INTO actions (action_key, run_id, tool, args_hash) VALUES ('action-1', $1, 'read', 'hash')`, [id],
    );
    const cases = [
      { sql: "INSERT INTO steps VALUES ($1, 1, 'tool', '{}', 'PENDING')", args: [missingId], code: '23503' },
      { sql: "INSERT INTO actions (action_key, run_id, tool, args_hash) VALUES ('orphan', $1, 'read', 'hash')", args: [missingId], code: '23503' },
      { sql: "INSERT INTO runs (id, tenant_id, status, budget_json) VALUES ($1, 'tenant-a', 'RUNNING', '{}')", args: [id], code: '23505' },
      { sql: "INSERT INTO steps VALUES ($1, 0, 'tool', '{}', 'PENDING')", args: [id], code: '23505' },
      { sql: "INSERT INTO actions (action_key, run_id, tool, args_hash) VALUES ('action-1', $1, 'read', 'hash')", args: [id], code: '23505' },
      { sql: "UPDATE actions SET status = 'RETRY' WHERE action_key = 'action-1'", args: [], code: '22P02' },
      { sql: "INSERT INTO runs (tenant_id, status, budget_json) VALUES (NULL, 'RUNNING', '{}')", args: [], code: '23502' },
      { sql: "INSERT INTO steps (run_id, seq, kind, status) VALUES ($1, 2, 'tool', 'PENDING')", args: [id], code: '23502' },
      { sql: "INSERT INTO actions (action_key, run_id, tool) VALUES ('incomplete', $1, 'read')", args: [id], code: '23502' },
      { sql: 'DELETE FROM runs WHERE id = $1', args: [id], code: '23503' },
    ];
    for (const { sql, args, code } of cases) {
      await expect(client.query(sql, args), sql).rejects.toMatchObject({ code });
    }
  });

});
