import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';

/** Projects visible beneath a tenant's configured top-level GitLab group. */
export const gitlabProjects = pgTable(
  'gitlab_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id'),
    groupId: text('group_id').notNull(),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    fullPath: text('full_path').notNull(),
    defaultBranch: text('default_branch'),
    visibility: text('visibility'),
    archived: boolean('archived').notNull().default(false),
    webUrl: text('web_url').notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).defaultNow().notNull(),
    pollCursor: jsonb('poll_cursor').$type<Record<string, unknown>>(),
    pollAttemptedAt: timestamp('poll_attempted_at', { withTimezone: true }),
    pollSucceededAt: timestamp('poll_succeeded_at', { withTimezone: true }),
    pollFailureCategory: text('poll_failure_category'),
    pollActive: boolean('poll_active').notNull().default(false),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('gitlab_projects_provider_uq')
      .on(t.tenantId, t.connectorId, t.projectId)
      .where(sql`${t.connectorId} is not null`),
    uniqueIndex('gitlab_projects_legacy_provider_uq')
      .on(t.tenantId, t.projectId)
      .where(sql`${t.connectorId} is null`),
    uniqueIndex('gitlab_projects_active_path_uq')
      .on(t.tenantId, t.connectorId, t.fullPath)
      .where(sql`${t.connectorId} is not null and ${t.removedAt} is null`),
    index('gitlab_projects_group_idx').on(t.tenantId, t.connectorId, t.groupId, t.removedAt),
    index('gitlab_projects_lookup_idx').on(t.tenantId, t.name, t.removedAt),
    index('gitlab_projects_poll_idx').on(t.tenantId, t.connectorId, t.removedAt, t.pollAttemptedAt),
    tenantIsolation(),
  ],
);

/** Allowlisted evidence from authenticated GitLab webhook deliveries. */
export const gitlabEvents = pgTable(
  'gitlab_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id'),
    deliveryId: text('delivery_id').notNull(),
    observationKey: text('observation_key'),
    eventType: text('event_type').notNull(),
    action: text('action'),
    projectId: text('project_id'),
    projectFullPath: text('project_full_path'),
    actor: text('actor'),
    ref: text('ref'),
    sha: text('sha'),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('gitlab_events_delivery_uq')
      .on(t.tenantId, t.connectorId, t.deliveryId)
      .where(sql`${t.connectorId} is not null`),
    uniqueIndex('gitlab_events_legacy_delivery_uq')
      .on(t.tenantId, t.deliveryId)
      .where(sql`${t.connectorId} is null`),
    index('gitlab_events_project_time_idx').on(t.tenantId, t.projectFullPath, t.occurredAt.desc()),
    index('gitlab_events_observation_idx').on(
      t.tenantId,
      t.connectorId,
      t.observationKey,
      t.receivedAt,
      t.id,
    ),
    index('gitlab_events_type_time_idx').on(t.tenantId, t.eventType, t.occurredAt.desc()),
    index('gitlab_events_timeline_idx').on(
      t.tenantId,
      t.connectorId,
      t.occurredAt.desc(),
      t.id.desc(),
    ),
    tenantIsolation(),
  ],
);
