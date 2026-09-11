// Surface adapters: per-tenant connection, thread <-> incident binding, and approval
// decisions. Bot tokens live in tenant_secrets via the SecretStore, never here. All under RLS.
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  check,
  unique,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { incidents } from './incidents';
import { tenantIsolation } from './rls';

/**
 * Per-tenant surface connection. One row per surface; the row's EXISTENCE is the connection —
 * there is no enable flag and no post target. The AI answers in the thread the alert arrived in,
 * so nothing is configured about where to post; what we listen to is `inbound_channels`. Disconnecting
 * is a hard delete of this row plus its secrets.
 */
export const surfaceConfigs = pgTable(
  'surface_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // e.g. slack
    surface: text('surface').notNull(),
    // The surface's own bot user id, used for mention recognition. Null until connection validation.
    botUserId: text('bot_user_id'),
    // Slack's verified bot identity. Distinct from bot_user_id.
    botId: text('bot_id'),
    // Verified Slack workspace identity from auth.test. Socket callbacks carry this id, so it is the
    // global routing authority before any tenant-scoped work can begin.
    teamId: text('team_id'),
    // Verified Slack app identity shared by the bot token, app token, and Socket envelope. Nullable so
    // pre-migration rows can be backfilled from their encrypted xapp token during startup.
    appId: text('app_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.tenantId, t.surface),
    unique('surface_configs_team_id_uq').on(t.teamId),
    tenantIsolation(),
  ],
);

/** Per-channel inbound subscription allowlist: a surface only ingests from subscribed+enabled channels. */
export const inboundChannels = pgTable(
  'inbound_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // e.g. slack
    surface: text('surface').notNull(),
    // The source channel ID, e.g. a Slack channel id (C07…). Slack events only ever carry IDs, so this
    // is what inbound matches on; a typed "#name" could never match.
    channel: text('channel').notNull(),
    // The channel's display name (e.g. "#homelab-notification") for the dashboard. Refreshed on every
    // subscribe/toggle so a Slack rename self-heals; null when we have never seen a name for it.
    channelName: text('channel_name'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('inbound_channels_tenant_surface_channel_uq').on(t.tenantId, t.surface, t.channel),
    tenantIsolation(),
  ],
);

/**
 * An addressable incident conversation per surface. Every incident starts with one primary binding in
 * the SAME transaction; correlation and merge may attach additional interactive roots.
 *
 * `channel` and `threadId` are stored separately because they are used separately: the poster needs the
 * channel to address chat.postMessage, and Slack's thread_ts is only meaningful INSIDE that channel
 *`externalId` stays as a GENERATED column so the by-thread lookup ("channel:thread_ts", the
 * shape Slack events give us) remains a single indexed equality.
 */
export const surfaceBindings = pgTable(
  'surface_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    // One incident may be reachable from several alert threads. The newest correlated thread becomes
    // primary and receives the full investigation; older threads receive concise lifecycle projection.
    role: text('role').$type<'primary' | 'source'>().notNull().default('primary'),
    projectionMode: text('projection_mode').$type<'full' | 'status'>().notNull().default('full'),
    // e.g. slack
    surface: text('surface').notNull(),
    // The channel that owns this conversation root, e.g. a Slack channel id (C07…).
    channel: text('channel').notNull(),
    // The root message of this bound conversation, e.g. a Slack thread_ts.
    threadId: text('thread_id').notNull(),
    // Derived "channel:thread_id" — the identifier an inbound event resolves by. Generated, never written.
    externalId: text('external_id')
      .notNull()
      .generatedAlwaysAs(sql`channel || ':' || thread_id`),
    // Platform-owned lifecycle reply. The alert root may belong to a third-party bot and cannot be
    // edited by our token, so lifecycle projection is maintained on this separate message.
    statusMessageId: text('status_message_id'),
    statusMessageVersion: integer('status_message_version').notNull().default(0),
    // Incremented whenever merge/split reassigns this thread. A delivery captures the generation so a
    // request that finishes after reassignment cannot advance the new owner's lifecycle fence.
    assignmentVersion: integer('assignment_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Every source thread is independently addressable, but only one is the current full-conversation
    // destination. Correlation and merge/split change roles without losing any thread or reply route.
    uniqueIndex('surface_bindings_primary_uq')
      .on(t.tenantId, t.surface, t.incidentId)
      .where(sql`${t.role} = 'primary'`),
    unique('surface_bindings_tenant_id_uq').on(t.tenantId, t.id),
    unique('surface_bindings_external_uq').on(t.tenantId, t.surface, t.externalId),
    check('surface_bindings_role_vocabulary', sql`role in ('primary', 'source')`),
    check('surface_bindings_projection_vocabulary', sql`projection_mode in ('full', 'status')`),
    check(
      'surface_bindings_role_projection',
      sql`(role = 'primary' and projection_mode = 'full') or (role = 'source' and projection_mode = 'status')`,
    ),
    // Tenant-scoped incident FK so the RI check can't reference/probe another tenant's incident.
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'surface_bindings_incident_fk',
    }),
    tenantIsolation(),
  ],
);

/** An advisory Recommended Action that surfaces render as fixed Approve/Deny buttons; first decision wins. */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    // A stable id for the action being approved; the idempotency key with (tenant, incident).
    actionId: text('action_id').notNull(),
    prompt: text('prompt').notNull(),
    // The choices, e.g. [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }].
    options: jsonb('options').notNull(),
    // The winning decision's option id; null until decided (first-decision-wins CAS).
    decision: text('decision'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('approvals_action_uq').on(t.tenantId, t.incidentId, t.actionId),
    // Composite unique so tenant-scoped children (incident_messages.approval_id) can FK
    // (tenant_id, id) -> here: RI checks bypass RLS, so a plain id FK would leak a cross-tenant
    // existence oracle. Mirrors incident_messages_tenant_id_uq. [pattern,]
    unique('approvals_tenant_id_uq').on(t.tenantId, t.id),
    // Tenant-scoped incident FK (RI checks bypass RLS; a plain FK would leak an existence oracle).
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
    }),
    tenantIsolation(),
  ],
);
