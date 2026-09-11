// Per-tenant connector configuration (non-secret settings). Credentials live in
// tenant_secrets via the SecretStore. Under RLS.
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';

export const connectorConfigs = pgTable(
  'connector_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    name: text('name').notNull().default('Data source'),
    /** Opaque routing key embedded in the provider webhook URL; HMAC remains the authentication. */
    webhookKey: uuid('webhook_key').unique(),
    lifecycleVersion: integer('lifecycle_version').notNull().default(0),
    settings: jsonb('settings').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    verificationAttemptedAt: timestamp('verification_attempted_at', { withTimezone: true }),
    verificationSucceededAt: timestamp('verification_succeeded_at', { withTimezone: true }),
    verificationFailureCategory: text('verification_failure_category'),
    verificationDurationMs: integer('verification_duration_ms'),
    verificationRateLimitRemaining: integer('verification_rate_limit_remaining'),
    verificationRateLimitResetAt: timestamp('verification_rate_limit_reset_at', {
      withTimezone: true,
    }),
    pollAttemptedAt: timestamp('poll_attempted_at', { withTimezone: true }),
    pollSucceededAt: timestamp('poll_succeeded_at', { withTimezone: true }),
    pollSnapshotCount: integer('poll_snapshot_count').notNull().default(0),
    pollErrorCount: integer('poll_error_count').notNull().default(0),
    pollFailureCategory: text('poll_failure_category'),
    pollDurationMs: integer('poll_duration_ms'),
    pollRateLimitRemaining: integer('poll_rate_limit_remaining'),
    pollRateLimitResetAt: timestamp('poll_rate_limit_reset_at', { withTimezone: true }),
    pollCursor: jsonb('poll_cursor'),
    eventAttemptedAt: timestamp('event_attempted_at', { withTimezone: true }),
    eventSucceededAt: timestamp('event_succeeded_at', { withTimezone: true }),
    eventCount: integer('event_count').notNull().default(0),
    eventFailureCategory: text('event_failure_category'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('connector_configs_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('connector_configs_active_name_uq')
      .on(t.tenantId, t.type, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
    index('connector_configs_tenant_type_idx').on(t.tenantId, t.type, t.deletedAt),
    tenantIsolation(),
  ],
);
