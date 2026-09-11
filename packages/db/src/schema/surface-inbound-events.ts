import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { jobs } from './jobs';
import { surfaceConfigs } from './surfaces';

export const SURFACE_INBOUND_STATES = [
  'queued',
  'processing',
  'processed',
  'retrying',
  'dropped',
] as const;
export type SurfaceInboundState = (typeof SURFACE_INBOUND_STATES)[number];

/** Secret-free durable receipt for every Socket Mode envelope before Slack is acknowledged. */
export const surfaceInboundEvents = pgTable(
  'surface_inbound_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    configId: uuid('config_id').references(() => surfaceConfigs.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    surface: text('surface').notNull(),
    deliveryKey: text('delivery_key').notNull(),
    envelopeType: text('envelope_type').notNull(),
    eventType: text('event_type'),
    eventSubtype: text('event_subtype'),
    channel: text('channel'),
    externalMessageId: text('external_message_id'),
    state: text('state').$type<SurfaceInboundState>().notNull(),
    outcome: text('outcome'),
    classificationOutcome: text('classification_outcome'),
    classificationUpdatedAt: timestamp('classification_updated_at', {
      withTimezone: true,
      precision: 3,
    }),
    terminalDisposition: text('terminal_disposition'),
    terminalDispositionAt: timestamp('terminal_disposition_at', {
      withTimezone: true,
      precision: 3,
    }),
    terminalDispositionEventAt: timestamp('terminal_disposition_event_at', {
      withTimezone: true,
      precision: 3,
    }),
    terminalDispositionEventVersion: bigint('terminal_disposition_event_version', {
      mode: 'number',
    }),
    attemptCount: integer('attempt_count').notNull().default(0),
    errorCode: text('error_code'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    unique('surface_inbound_events_delivery_uq').on(t.surface, t.deliveryKey),
    index('surface_inbound_events_tenant_recent_idx').on(t.tenantId, t.surface, t.acceptedAt),
    index('surface_inbound_events_message_idx').on(
      t.tenantId,
      t.surface,
      t.channel,
      t.externalMessageId,
    ),
    index('surface_inbound_events_state_idx').on(t.state, t.updatedAt),
    check(
      'surface_inbound_events_state_vocabulary',
      sql`state in ('queued', 'processing', 'processed', 'retrying', 'dropped')`,
    ),
  ],
);
