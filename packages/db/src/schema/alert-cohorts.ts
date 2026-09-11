import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { connectorConfigs } from './connectors';
import { tenants } from './control-plane';
import { incidentSignals } from './incident-signals';
import { tenantIsolation } from './rls';

export const ALERT_COHORT_STATES = ['collecting', 'analyzing', 'settled'] as const;
export type AlertCohortState = (typeof ALERT_COHORT_STATES)[number];

/** A bounded candidate set for alerts that arrived close together, never proof of one incident. */
export const alertCohorts = pgTable(
  'alert_cohorts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Authenticated provider or surface scope; timing alone never crosses this boundary. */
    sourceScopeKey: text('source_scope_key').notNull(),
    dataSourceId: uuid('data_source_id'),
    anchorSignalId: uuid('anchor_signal_id').notNull(),
    state: text('state').$type<AlertCohortState>().notNull().default('collecting'),
    analysisJobId: uuid('analysis_job_id'),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true, precision: 3 }).notNull(),
    windowEndsAt: timestamp('window_ends_at', { withTimezone: true, precision: 3 }).notNull(),
    lastAlertAt: timestamp('last_alert_at', { withTimezone: true, precision: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    unique('alert_cohorts_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.dataSourceId],
      foreignColumns: [connectorConfigs.tenantId, connectorConfigs.id],
      name: 'alert_cohorts_data_source_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.anchorSignalId],
      foreignColumns: [incidentSignals.tenantId, incidentSignals.id],
      name: 'alert_cohorts_anchor_signal_fk',
    }),
    index('alert_cohorts_collecting_idx').on(t.tenantId, t.sourceScopeKey, t.state, t.windowEndsAt),
    check('alert_cohorts_state_vocabulary', sql`state in ('collecting', 'analyzing', 'settled')`),
    check(
      'alert_cohorts_analysis_job_present',
      sql`state <> 'analyzing' or ${t.analysisJobId} is not null`,
    ),
    check('alert_cohorts_window_order', sql`window_ends_at >= window_started_at`),
    check('alert_cohorts_source_scope_present', sql`btrim(${t.sourceScopeKey}) <> ''`),
    tenantIsolation(),
  ],
);

/** Membership is independent of incident assignment so correlation can later merge or split safely. */
export const alertCohortMembers = pgTable(
  'alert_cohort_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cohortId: uuid('cohort_id').notNull(),
    signalId: uuid('signal_id').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    unique('alert_cohort_members_signal_uq').on(t.tenantId, t.signalId),
    foreignKey({
      columns: [t.tenantId, t.cohortId],
      foreignColumns: [alertCohorts.tenantId, alertCohorts.id],
      name: 'alert_cohort_members_cohort_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.signalId],
      foreignColumns: [incidentSignals.tenantId, incidentSignals.id],
      name: 'alert_cohort_members_signal_fk',
    }),
    index('alert_cohort_members_cohort_idx').on(t.tenantId, t.cohortId, t.joinedAt),
    tenantIsolation(),
  ],
);
