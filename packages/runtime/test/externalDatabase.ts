import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
/** Isolated per-suite database on the controller-admitted, already-running fixture. */
export async function externalDatabase() {
  const base = process.env['KEEL_TEST_POSTGRES_URL'];
  if (!base) return undefined;
  const admin = new Client({ connectionString: base });
  const name = 'fixture_' + randomUUID().replaceAll('-', '');
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
  const url = new URL(base); url.pathname = '/' + name;
  return { getConnectionUri: () => url.href, async stop() {
    const admin = new Client({ connectionString: base }); await admin.connect();
    try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await admin.end(); }
  } };
}
