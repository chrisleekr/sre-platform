import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';

/** Lightweight catalog of repositories visible to a tenant's GitHub App installation. */
export const githubRepositories = pgTable(
  'github_repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id'),
    installationId: text('installation_id').notNull(),
    repositoryId: text('repository_id').notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch'),
    private: boolean('private').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    htmlUrl: text('html_url').notNull(),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).defaultNow().notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('github_repositories_provider_uq')
      .on(t.tenantId, t.connectorId, t.repositoryId)
      .where(sql`${t.connectorId} is not null`),
    uniqueIndex('github_repositories_legacy_provider_uq')
      .on(t.tenantId, t.repositoryId)
      .where(sql`${t.connectorId} is null`),
    uniqueIndex('github_repositories_active_name_uq')
      .on(t.tenantId, t.connectorId, t.fullName)
      .where(sql`${t.connectorId} is not null and ${t.removedAt} is null`),
    index('github_repositories_installation_idx').on(
      t.tenantId,
      t.connectorId,
      t.installationId,
      t.removedAt,
    ),
    index('github_repositories_lookup_idx').on(t.tenantId, t.name, t.removedAt),
    tenantIsolation(),
  ],
);

/** Durable, allowlisted GitHub webhook evidence. Raw webhook bodies are never persisted. */
export const githubEvents = pgTable(
  'github_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id'),
    deliveryId: text('delivery_id').notNull(),
    eventType: text('event_type').notNull(),
    action: text('action'),
    repositoryId: text('repository_id'),
    repositoryFullName: text('repository_full_name'),
    actor: text('actor'),
    ref: text('ref'),
    sha: text('sha'),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('github_events_delivery_uq')
      .on(t.tenantId, t.connectorId, t.deliveryId)
      .where(sql`${t.connectorId} is not null`),
    uniqueIndex('github_events_legacy_delivery_uq')
      .on(t.tenantId, t.deliveryId)
      .where(sql`${t.connectorId} is null`),
    index('github_events_repository_time_idx').on(
      t.tenantId,
      t.repositoryFullName,
      t.occurredAt.desc(),
    ),
    index('github_events_type_time_idx').on(t.tenantId, t.eventType, t.occurredAt.desc()),
    index('github_events_timeline_idx').on(
      t.tenantId,
      t.connectorId,
      t.occurredAt.desc(),
      t.id.desc(),
    ),
    tenantIsolation(),
  ],
);

/** Many-to-many service-to-source relationship used to resolve code during an incident. */
export const serviceRepositories = pgTable(
  'service_repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    service: text('service').notNull(),
    provider: text('provider').notNull(),
    repositoryFullName: text('repository_full_name').notNull(),
    path: text('path').notNull().default(''),
    source: text('source').notNull(),
    confirmed: boolean('confirmed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('service_repositories_mapping_uq').on(
      t.tenantId,
      t.service,
      t.provider,
      t.repositoryFullName,
      t.path,
    ),
    index('service_repositories_service_idx').on(t.tenantId, t.service, t.provider),
    tenantIsolation(),
  ],
);

/** Short-lived CSRF-bound state for the GitHub App Manifest registration handshake. */
export const githubManifestSessions = pgTable(
  'github_manifest_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    stateHash: text('state_hash').notNull(),
    dataSourceName: text('data_source_name').notNull().default('GitHub'),
    ownerType: text('owner_type').notNull(),
    organization: text('organization'),
    webhookUrl: text('webhook_url').notNull(),
    redirectUrl: text('redirect_url').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('github_manifest_sessions_state_uq').on(t.tenantId, t.stateHash),
    index('github_manifest_sessions_expiry_idx').on(t.expiresAt),
    tenantIsolation(),
  ],
);
