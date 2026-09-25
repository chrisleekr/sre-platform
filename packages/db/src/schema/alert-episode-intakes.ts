import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { connectorConfigs } from './connectors';
import { tenants } from './control-plane';
import { incidents } from './incidents';
import { surfaceBindings } from './surfaces';
import { tenantIsolation } from './rls';

export const ALERT_INTAKE_STATES = [
  'pending',
  'posting',
  'posted',
  'accepted',
  'rejected',
  'uncertain',
] as const;
export type AlertIntakeState = (typeof ALERT_INTAKE_STATES)[number];

export interface StoredAlertmanagerObservation {
  lifecycleVersion?: number;
  provider?: 'alertmanager' | 'grafana' | 'datadog' | 'statuscake';
  status: 'firing' | 'resolved';
  groupKey: string;
  alertName: string;
  monitorIdentity?: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  endsAt: string | null;
  generatorUrl: string | null;
  externalUrl: string | null;
}

/** Durable fence between provider delivery, Slack root creation, and incident creation. */
export const alertEpisodeIntakes = pgTable(
  'alert_episode_intakes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dataSourceId: uuid('data_source_id').notNull(),
    providerFingerprint: text('provider_fingerprint').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true, precision: 3 }),
    opaqueEpisodeKey: text('opaque_episode_key'),
    materialHash: text('material_hash').notNull(),
    observation: jsonb('observation').$type<StoredAlertmanagerObservation>().notNull(),
    channel: text('channel').notNull(),
    state: text('state').$type<AlertIntakeState>().notNull().default('pending'),
    rootMessageId: text('root_message_id'),
    incidentId: uuid('incident_id'),
    bindingId: uuid('binding_id'),
    attemptCount: integer('attempt_count').notNull().default(0),
    failureCategory: text('failure_category'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    unique('alert_episode_intakes_opaque_episode_uq').on(
      t.tenantId,
      t.dataSourceId,
      t.opaqueEpisodeKey,
    ),
    unique('alert_episode_intakes_episode_uq').on(
      t.tenantId,
      t.dataSourceId,
      t.providerFingerprint,
      t.startsAt,
    ),
    unique('alert_episode_intakes_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.dataSourceId],
      foreignColumns: [connectorConfigs.tenantId, connectorConfigs.id],
      name: 'alert_episode_intakes_data_source_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'alert_episode_intakes_incident_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.bindingId],
      foreignColumns: [surfaceBindings.tenantId, surfaceBindings.id],
      name: 'alert_episode_intakes_binding_fk',
    }),
    check(
      'alert_episode_intakes_state_vocabulary',
      sql`state in ('pending', 'posting', 'posted', 'accepted', 'rejected', 'uncertain')`,
    ),
    check(
      'alert_episode_intakes_root_state',
      sql`(state in ('pending', 'posting', 'rejected', 'uncertain') and root_message_id is null) or (state in ('posted', 'accepted') and root_message_id is not null)`,
    ),
    // Postgres treats NULLs as distinct, so a row with neither key escapes both unique constraints.
    check(
      'alert_episode_intakes_episode_identity',
      sql`starts_at is not null or opaque_episode_key is not null`,
    ),
    check(
      'alert_episode_intakes_acceptance',
      sql`state <> 'accepted' or (incident_id is not null and binding_id is not null)`,
    ),
    index('alert_episode_intakes_state_idx').on(t.tenantId, t.state, t.updatedAt),
    tenantIsolation(),
  ],
);
