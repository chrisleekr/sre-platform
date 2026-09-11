import type {
  AffectedEntityCandidate,
  IncidentCorrelationMethod,
  SignalSource,
} from '@sre/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { connectorConfigs } from './connectors';
import { tenants } from './control-plane';
import { incidents } from './incidents';
import { tenantIsolation } from './rls';

export const SIGNAL_STATES = ['firing', 'unknown', 'resolved'] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

// `updated` and `refired` are observations, not current states. Keeping both facts prevents an edit that
// merely changes a measured value from pretending the alert stopped firing.
export const SIGNAL_EVENT_TYPES = ['opened', 'updated', 'resolved', 'refired'] as const;
export type SignalEventType = (typeof SIGNAL_EVENT_TYPES)[number];

const vocabulary = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`);

/** Current state of one external alert instance attached to an incident. */
export const incidentSignals = pgTable(
  'incident_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    // Provider-native identity. Slack-only signals leave these null and retain the legacy external
    // message identity below. Alertmanager episodes use (data source, fingerprint, starts_at), which
    // distinguishes a continuing notification from a fresh firing after resolution even when every
    // rendered word is identical.
    dataSourceId: uuid('data_source_id'),
    provider: text('provider'),
    providerFingerprint: text('provider_fingerprint'),
    providerGroupKey: text('provider_group_key'),
    monitorKey: text('monitor_key'),
    alertName: text('alert_name'),
    startsAt: timestamp('starts_at', { withTimezone: true, precision: 3 }),
    endsAt: timestamp('ends_at', { withTimezone: true, precision: 3 }),
    labels: jsonb('labels').$type<Record<string, string>>(),
    annotations: jsonb('annotations').$type<Record<string, string>>(),
    generatorUrl: text('generator_url'),
    signalSource: jsonb('signal_source').$type<SignalSource>(),
    affectedEntities: jsonb('affected_entities').$type<AffectedEntityCandidate[]>(),
    // Hash only the investigation-relevant normalized fields. Transport retries with the same hash
    // update last_seen without spending another LLM turn; a changed hash queues a delta assessment.
    materialHash: text('material_hash'),
    lastInvestigatedMaterialHash: text('last_investigated_material_hash'),
    lastInvestigatedVersion: integer('last_investigated_version'),
    // The provider-neutral routing decision for this episode. Nullable for historical signals and
    // sources that do not yet offer a stable subject identity.
    correlationMethod: text('correlation_method').$type<IncidentCorrelationMethod>(),
    correlationRationale: text('correlation_rationale'),
    correlationFeatures: jsonb('correlation_features').$type<string[]>(),
    correlationConfidence: integer('correlation_confidence'),
    correlationWindowStartedAt: timestamp('correlation_window_started_at', {
      withTimezone: true,
      precision: 3,
    }),
    correlationWindowExpiresAt: timestamp('correlation_window_expires_at', {
      withTimezone: true,
      precision: 3,
    }),
    correlationMaxAgeAt: timestamp('correlation_max_age_at', {
      withTimezone: true,
      precision: 3,
    }),
    surface: text('surface').notNull(),
    channel: text('channel').notNull(),
    // The original alert message. A separate provider resolution message updates this row but retains
    // the original identity, while last_event_key identifies that later observation.
    externalMessageId: text('external_message_id').notNull(),
    state: text('state').$type<SignalState>().notNull(),
    lastEventType: text('last_event_type').$type<SignalEventType>().notNull(),
    summary: text('summary').notNull(),
    contentHash: text('content_hash').notNull(),
    lastEventKey: text('last_event_key').notNull(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true, precision: 3 }).notNull(),
    lastEventVersion: bigint('last_event_version', { mode: 'number' }),
    version: integer('version').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, precision: 3 }),
  },
  (t) => [
    unique('incident_signals_external_uq').on(
      t.tenantId,
      t.surface,
      t.channel,
      t.externalMessageId,
    ),
    unique('incident_signals_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('incident_signals_provider_episode_uq')
      .on(t.tenantId, t.dataSourceId, t.providerFingerprint, t.startsAt)
      .where(
        sql`${t.dataSourceId} is not null and ${t.providerFingerprint} is not null and ${t.startsAt} is not null`,
      ),
    index('incident_signals_incident_state_idx').on(t.tenantId, t.incidentId, t.state),
    index('incident_signals_correlation_scope_idx')
      .on(t.tenantId, t.dataSourceId, t.monitorKey, t.state, t.incidentId, t.firstSeenAt.desc())
      .where(sql`${t.dataSourceId} is not null and ${t.monitorKey} is not null`),
    index('incident_signals_correlation_history_idx')
      .on(t.tenantId, t.dataSourceId, t.monitorKey, t.incidentId, t.firstSeenAt.desc(), t.id.desc())
      .where(sql`${t.dataSourceId} is not null and ${t.monitorKey} is not null`),
    index('incident_signals_surface_monitor_active_idx')
      .on(t.tenantId, t.surface, t.channel, t.monitorKey, t.state, t.lastSeenAt.desc())
      .where(sql`${t.dataSourceId} is null and ${t.monitorKey} is not null`),
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_signals_incident_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.dataSourceId],
      foreignColumns: [connectorConfigs.tenantId, connectorConfigs.id],
      name: 'incident_signals_data_source_fk',
    }),
    check('incident_signals_state_vocabulary', vocabulary('state', SIGNAL_STATES)),
    check(
      'incident_signals_event_type_vocabulary',
      vocabulary('last_event_type', SIGNAL_EVENT_TYPES),
    ),
    check(
      'incident_signals_last_investigated_version_positive',
      sql`${t.lastInvestigatedVersion} is null or ${t.lastInvestigatedVersion} > 0`,
    ),
    check(
      'incident_signals_signal_source_shape',
      sql`${t.signalSource} is null or jsonb_typeof(${t.signalSource}) = 'object'`,
    ),
    check(
      'incident_signals_affected_entities_shape',
      sql`${t.affectedEntities} is null or jsonb_typeof(${t.affectedEntities}) = 'array'`,
    ),
    check(
      'incident_signals_correlation_method_vocabulary',
      sql`${t.correlationMethod} is null or ${t.correlationMethod} in ('new_incident', 'stable_subject_window')`,
    ),
    check(
      'incident_signals_correlation_confidence_range',
      sql`${t.correlationConfidence} is null or (${t.correlationConfidence} >= 0 and ${t.correlationConfidence} <= 100)`,
    ),
    check(
      'incident_signals_correlation_decision_shape',
      sql`(
        (
          ${t.correlationMethod} is null
          and ${t.correlationRationale} is null
          and ${t.correlationFeatures} is null
          and ${t.correlationConfidence} is null
          and ${t.correlationWindowStartedAt} is null
          and ${t.correlationWindowExpiresAt} is null
          and ${t.correlationMaxAgeAt} is null
        )
        or coalesce((
          ${t.correlationMethod} is not null
          and ${t.correlationRationale} is not null
          and btrim(${t.correlationRationale}) <> ''
          and ${t.correlationFeatures} is not null
          and jsonb_typeof(${t.correlationFeatures}) = 'array'
          and not jsonb_path_exists(${t.correlationFeatures}, '$[*] ? (@.type() != "string")')
          and ${t.correlationConfidence} is not null
          and ${t.correlationWindowStartedAt} is not null
          and ${t.correlationWindowExpiresAt} is not null
          and ${t.correlationMaxAgeAt} is not null
          and ${t.correlationWindowExpiresAt} >= ${t.correlationWindowStartedAt}
          and ${t.correlationMaxAgeAt} >= ${t.correlationWindowStartedAt}
        ), false)
      )`,
    ),
    tenantIsolation(),
  ],
);
