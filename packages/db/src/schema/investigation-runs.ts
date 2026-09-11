import {
  INVESTIGATION_OPERATIONS,
  INVESTIGATION_RUN_OUTCOMES,
  INVESTIGATION_TRIGGER_REASONS,
  type InvestigationBudgetSnapshot,
  type InvestigationOperation,
  type InvestigationRunOutcome,
  type InvestigationTriggerReason,
} from '@sre/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';

const vocabulary = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`);

export const investigationRuns = pgTable(
  'investigation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    jobId: uuid('job_id'),
    operation: text('operation').$type<InvestigationOperation>().notNull(),
    triggerReason: text('trigger_reason').$type<InvestigationTriggerReason>(),
    triggerAutomatic: boolean('trigger_automatic').notNull().default(false),
    triggerMonitorKey: text('trigger_monitor_key'),
    triggerMonitorKeys: text('trigger_monitor_keys')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    triggerBudget: jsonb('trigger_budget').$type<InvestigationBudgetSnapshot>(),
    admissionDenied: boolean('admission_denied').notNull().default(false),
    provider: text('provider'),
    engineModel: text('engine_model'),
    engineSessionId: text('engine_session_id'),
    turnBudget: integer('turn_budget').notNull().default(0),
    outcome: text('outcome').$type<InvestigationRunOutcome>(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    evidenceIds: uuid('evidence_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    startedAt: timestamp('started_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    unique('investigation_runs_tenant_id_uq').on(table.tenantId, table.id),
    unique('investigation_runs_tenant_incident_id_uq').on(
      table.tenantId,
      table.incidentId,
      table.id,
    ),
    check(
      'investigation_runs_operation_vocabulary',
      vocabulary('operation', INVESTIGATION_OPERATIONS),
    ),
    check(
      'investigation_runs_outcome_vocabulary',
      vocabulary('outcome', INVESTIGATION_RUN_OUTCOMES),
    ),
    check(
      'investigation_runs_trigger_reason_vocabulary',
      sql`${table.triggerReason} is null or ${vocabulary('trigger_reason', INVESTIGATION_TRIGGER_REASONS)}`,
    ),
    check(
      'investigation_runs_completion_shape',
      sql`((${table.outcome} is null and ${table.result} is null and ${table.completedAt} is null) or (${table.outcome} is not null and ${table.result} is not null and ${table.completedAt} is not null))`,
    ),
    index('investigation_runs_incident_started_idx').on(
      table.tenantId,
      table.incidentId,
      table.startedAt.desc(),
      table.id.desc(),
    ),
    index('investigation_runs_automatic_started_idx').on(
      table.tenantId,
      table.triggerAutomatic,
      table.startedAt.desc(),
    ),
    tenantIsolation(),
  ],
);
