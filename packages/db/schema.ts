import { integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const actionStatus = pgEnum('action_status', ['PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN']);

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  budgetJson: jsonb('budget_json').notNull(),
});

export const steps = pgTable('steps', {
  runId: uuid('run_id').notNull().references(() => runs.id),
  seq: integer('seq').notNull(),
  kind: text('kind').notNull(),
  payloadJson: jsonb('payload_json').notNull(),
  status: text('status').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.seq] })]);

export const actions = pgTable('actions', {
  actionKey: text('action_key').primaryKey(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  tool: text('tool').notNull(),
  argsHash: text('args_hash').notNull(),
  status: actionStatus('status').notNull().default('PENDING'),
  resultJson: jsonb('result_json'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
