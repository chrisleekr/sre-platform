import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';

/** Explicit authorization, separate from the read-only connector settings and credential. */
export const gitlabHookAuthorizations = pgTable(
  'gitlab_hook_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id').notNull(),
    lifecycleVersion: integer('lifecycle_version').notNull(),
    policyVersion: integer('policy_version').notNull(),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default({}),
    approvedBy: uuid('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    catalogPage: integer('catalog_page').notNull().default(1),
    catalogCheckedAt: timestamp('catalog_checked_at', { withTimezone: true }),
    retryAt: timestamp('retry_at', { withTimezone: true }),
    failureCategory: text('failure_category'),
  },
  (t) => [
    uniqueIndex('gitlab_hook_authorization_connector_uq')
      .on(t.tenantId, t.connectorId)
      .where(sql`${t.revokedAt} is null`),
    tenantIsolation(),
  ],
);

/** Creation intent survives an uncertain provider response; ownership is never inferred from URL. */
export const gitlabManagedHooks = pgTable(
  'gitlab_managed_hooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id').notNull(),
    projectId: text('project_id').notNull(),
    projectPath: text('project_path').notNull(),
    ownershipId: uuid('ownership_id').notNull().defaultRandom(),
    hookId: text('hook_id'),
    scanPage: integer('scan_page').notNull().default(1),
    createAttemptedAt: timestamp('create_attempted_at', { withTimezone: true }),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    appliedAuthorizationId: uuid('applied_authorization_id'),
    removed: boolean('removed').notNull().default(false),
    failureCategory: text('failure_category'),
  },
  (t) => [
    uniqueIndex('gitlab_managed_hook_project_uq').on(t.tenantId, t.connectorId, t.projectId),
    uniqueIndex('gitlab_managed_hook_ownership_uq').on(t.tenantId, t.ownershipId),
    index('gitlab_managed_hook_work_idx').on(t.tenantId, t.connectorId, t.removed, t.attemptedAt),
    tenantIsolation(),
  ],
);
