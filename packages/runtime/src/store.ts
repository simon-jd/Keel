import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { runs, steps, actions } from 'db/schema';
import type { Checkpoint } from './types.js';

type Step = { seq: number; kind: string; payload: unknown; status: string };
/** One dedicated connection owns the advisory lock for the whole loop, never a pooled transaction lock. */
export class PostgresStore {
  constructor(readonly connectionString: string) {}
  async withRun<T>(runId: string, work: (session: RunSession) => Promise<T>): Promise<T | undefined> {
    const client = new Client({ connectionString: this.connectionString });
    const controller = new AbortController();
    client.on('error', () => controller.abort());
    try {
      await client.connect();
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [runId]);
      if (!lock.rows[0]?.locked) return undefined;
      return await work(new RunSession(client, runId, controller.signal));
    } finally {
      // Closing the owning session releases its lock, including any failed transaction.
      await client.end().catch(() => {});
    }
  }
}
export class RunSession {
  private readonly db;
  constructor(private readonly client: Client, readonly runId: string, readonly signal: AbortSignal) { this.db = drizzle(client); }
  async load() { return (await this.db.select().from(runs).where(eq(runs.id, this.runId)))[0]; }
  async create(tenantId: string, checkpoint: Checkpoint) {
    await this.db.insert(runs).values({ id: this.runId, tenantId, status: 'RUNNING', budgetJson: checkpoint });
  }
  async save(checkpoint: Checkpoint, status = 'RUNNING', step?: Step) {
    await this.transaction(async () => {
      await this.db.update(runs).set({ status, budgetJson: checkpoint }).where(eq(runs.id, this.runId));
      if (step) await this.db.insert(steps).values({ runId: this.runId, seq: step.seq, kind: step.kind, payloadJson: step.payload, status: step.status })
        .onConflictDoUpdate({ target: [steps.runId, steps.seq], set: { payloadJson: step.payload, status: step.status } });
    });
  }
  async action(key: string) { return (await this.db.select().from(actions).where(and(eq(actions.actionKey, key), eq(actions.runId, this.runId))))[0]; }
  async reserveAction(checkpoint: Checkpoint, key: string, tool: string, argsHash: string, step: Step) {
    await this.transaction(async () => {
      await this.db.insert(actions).values({ actionKey: key, runId: this.runId, tool, argsHash }).onConflictDoUpdate({ target: actions.actionKey, set: { status: 'PENDING', updatedAt: new Date() } });
      await this.db.update(runs).set({ status: 'RUNNING', budgetJson: checkpoint }).where(eq(runs.id, this.runId));
      await this.db.insert(steps).values({ runId: this.runId, seq: step.seq, kind: step.kind, payloadJson: step.payload, status: step.status })
        .onConflictDoUpdate({ target: [steps.runId, steps.seq], set: { status: step.status } });
    });
  }
  async markAction(key: string, status: 'UNKNOWN' | 'SUCCEEDED' | 'FAILED', result: unknown = null) {
    await this.db.update(actions).set({ status, resultJson: result, updatedAt: new Date() }).where(and(eq(actions.actionKey, key), eq(actions.runId, this.runId)));
  }
  private async transaction(work: () => Promise<void>) {
    this.signal.throwIfAborted();
    await this.client.query('BEGIN');
    try { await work(); await this.client.query('COMMIT'); }
    catch (error) { await this.client.query('ROLLBACK').catch(() => {}); throw error; }
  }
}
