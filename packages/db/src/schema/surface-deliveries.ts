import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { incidents } from './incidents';
import { incidentMessages } from './incident-messages';
import { surfaceBindings } from './surfaces';
import { tenantIsolation } from './rls';

export const SURFACE_DELIVERY_STATES = [
  'queued',
  'sending',
  'accepted',
  'rejected',
  'uncertain',
  'blocked',
  'skipped',
] as const;

export type SurfaceDeliveryState = (typeof SURFACE_DELIVERY_STATES)[number];

/**
 * Durable surface outbox and receipt. `accepted` means the remote API returned success. It never means
 * delivered to, or read by, a human. A transport failure after request dispatch is `uncertain`, because
 * retrying an ambiguous Slack post can duplicate it.
 */
export const surfaceDeliveries = pgTable(
  'surface_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    messageId: uuid('message_id').notNull(),
    bindingId: uuid('binding_id').notNull(),
    // Binding ownership generation captured when this outbox row is created.
    bindingAssignmentVersion: integer('binding_assignment_version').notNull().default(0),
    surface: text('surface').notNull(),
    state: text('state').$type<SurfaceDeliveryState>().notNull().default('queued'),
    operation: text('operation').notNull().default('composite'),
    remoteMessageId: text('remote_message_id'),
    // Stable, secret-free category only. Raw exceptions stay in structured server logs.
    reasonCode: text('reason_code'),
    // Durable eligibility for safe retries that are known not to have reached the remote service.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true, precision: 3 }),
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    unique('surface_deliveries_message_binding_uq').on(t.tenantId, t.messageId, t.bindingId),
    index('surface_deliveries_queued_idx').on(t.state, t.nextAttemptAt, t.createdAt, t.id),
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'surface_deliveries_incident_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.messageId],
      foreignColumns: [incidentMessages.tenantId, incidentMessages.id],
      name: 'surface_deliveries_message_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.bindingId],
      foreignColumns: [surfaceBindings.tenantId, surfaceBindings.id],
      name: 'surface_deliveries_binding_fk',
    }),
    check(
      'surface_deliveries_state_vocabulary',
      sql.raw(`state in (${SURFACE_DELIVERY_STATES.map((state) => `'${state}'`).join(', ')})`),
    ),
    tenantIsolation(),
  ],
);
