import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { externalDatabase } from './externalDatabase.js';
/** Isolated pgvector Postgres for a test suite: KEEL_TEST_POSTGRES_URL if set, else a labeled testcontainer. */
export async function postgres(purpose: string) {
  return await externalDatabase() ?? await new PostgreSqlContainer('pgvector/pgvector:0.8.1-pg17').withLabels({ project: 'keel', purpose }).withResourcesQuota({ memory: 512 * 1024 * 1024, cpu: 1 }).start();
}
