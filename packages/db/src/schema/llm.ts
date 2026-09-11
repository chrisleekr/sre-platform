import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { incidents } from './incidents';
import { tenantIsolation } from './rls';

export const LLM_INVOCATION_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type LlmInvocationStatus = (typeof LLM_INVOCATION_STATUSES)[number];

export const llmInvocations = pgTable(
  'llm_invocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id'),
    jobId: uuid('job_id'),
    operation: text('operation').notNull(),
    runtime: text('runtime').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    config: jsonb('config').$type<unknown>().notNull(),
    pricing: jsonb('pricing').$type<unknown>(),
    configUpdatedAt: timestamp('config_updated_at', { withTimezone: true }),
    status: text('status').$type<LlmInvocationStatus>().notNull().default('running'),
    errorCategory: text('error_category'),
    requestCount: integer('request_count').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    usageReported: boolean('usage_reported').notNull().default(false),
    configuredCostUsd: numeric('configured_cost_usd', { precision: 24, scale: 12 }),
    providerEstimatedCostUsd: numeric('provider_estimated_cost_usd', {
      precision: 24,
      scale: 12,
    }),
    telemetryComplete: boolean('telemetry_complete'),
    startedAt: timestamp('started_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
  },
  (t) => [
    unique('llm_invocations_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'llm_invocations_incident_fk',
    }),
    index('llm_invocations_started_idx').on(t.startedAt.desc()),
    index('llm_invocations_tenant_started_idx').on(t.tenantId, t.startedAt.desc(), t.id.desc()),
    index('llm_invocations_incident_started_idx').on(t.incidentId, t.startedAt.desc()),
    check('llm_invocations_status_vocabulary', sql`status in ('running', 'succeeded', 'failed')`),
    check(
      'llm_invocations_nonnegative_usage',
      sql`${t.requestCount} >= 0 and ${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.cacheReadTokens} >= 0 and ${t.cacheWriteTokens} >= 0`,
    ),
    check(
      'llm_invocations_configured_cost_nonnegative_finite',
      sql`${t.configuredCostUsd} is null or (${t.requestCount} > 0 and ${t.inputTokens} + ${t.outputTokens} + ${t.cacheReadTokens} + ${t.cacheWriteTokens} > 0 and ${t.configuredCostUsd} >= 0 and ${t.configuredCostUsd} < 'Infinity'::numeric)`,
    ),
    check(
      'llm_invocations_provider_cost_nonnegative_finite',
      sql`${t.providerEstimatedCostUsd} is null or (${t.providerEstimatedCostUsd} >= 0 and ${t.providerEstimatedCostUsd} < 'Infinity'::numeric)`,
    ),
    tenantIsolation(),
  ],
);

/** Ordered Claude Code OTLP log records. Payloads are redacted before this boundary. */
export const llmTelemetryEvents = pgTable(
  'llm_telemetry_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invocationId: uuid('invocation_id').notNull(),
    kind: text('kind').notNull(),
    providerSequence: integer('provider_sequence'),
    providerTimestamp: timestamp('provider_timestamp', { withTimezone: true, precision: 3 }),
    model: text('model'),
    payload: jsonb('payload').$type<unknown>().notNull(),
    bodyBytes: integer('body_bytes'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invocationId],
      foreignColumns: [llmInvocations.tenantId, llmInvocations.id],
      name: 'llm_telemetry_events_invocation_fk',
    }),
    index('llm_telemetry_events_invocation_sequence_idx').on(
      t.invocationId,
      t.providerSequence,
      t.createdAt,
    ),
    tenantIsolation(),
  ],
);
