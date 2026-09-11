// Persisted deploys (MR1): the poller records each polled deploy snapshot so the dashboard/agent
// can correlate an incident with what shipped just before it. Under RLS.
import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';

export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id'),
    // Connector that produced the deploy (e.g. 'gitlab').
    source: text('source').notNull(),
    // Stable event identifier assigned by the provider. Null only for history written before the
    // provider-identity migration or connectors that do not expose an event id.
    providerId: text('provider_id'),
    // Project identifier as the connector reports it (a gitlab projectId or path).
    repo: text('repo').notNull(),
    // Deployed ref/branch; null when the connector does not carry one.
    ref: text('ref'),
    environment: text('environment'),
    transientEnvironment: boolean('transient_environment').notNull().default(false),
    actor: text('actor'),
    // Primary revision for single-source deploys and compatibility anchor for multi-source history.
    sha: text('sha').notNull(),
    revisions: jsonb('revisions').$type<string[]>(),
    operationPhase: text('operation_phase'),
    // The canonical service this deploy targets (mirrors incidents.service). Nullable: a connector may
    // not map a deploy to a service.
    service: text('service'),
    status: text('status').notNull(),
    // Deploy/pipeline URL as the connector reports it. Nullable: not every connector carries one.
    url: text('url'),
    deployedAt: timestamp('deployed_at', { withTimezone: true }).notNull(),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }),
    providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }),
    // Advisory error-budget stamp taken when the deploy was persisted: the narrowest remaining budget
    // across the target service's objectives, and whether that clears the high-risk threshold. Null
    // when the service has no objective, no evaluation yet, or the lookup failed. Advisory only: the
    // platform reports this, it never blocks a deploy on it.
    budgetRemaining: doublePrecision('budget_remaining'),
    highRisk: boolean('high_risk').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('deployments_provider_event_uq')
      .on(t.tenantId, t.connectorId, t.source, t.repo, t.providerId)
      .where(
        sql`${t.connectorId} is not null and ${t.providerId} is not null and ${t.source} <> 'argocd'`,
      ),
    uniqueIndex('deployments_argocd_provider_event_uq')
      .on(t.tenantId, t.connectorId, t.source, t.providerId)
      .where(
        sql`${t.connectorId} is not null and ${t.providerId} is not null and ${t.source} = 'argocd'`,
      ),
    uniqueIndex('deployments_legacy_sha_uq')
      .on(t.tenantId, t.connectorId, t.source, t.sha)
      .where(sql`${t.connectorId} is not null and ${t.providerId} is null`),
    uniqueIndex('deployments_unscoped_provider_event_uq')
      .on(t.tenantId, t.source, t.repo, t.providerId)
      .where(
        sql`${t.connectorId} is null and ${t.providerId} is not null and ${t.source} <> 'argocd'`,
      ),
    uniqueIndex('deployments_unscoped_argocd_provider_event_uq')
      .on(t.tenantId, t.source, t.providerId)
      .where(
        sql`${t.connectorId} is null and ${t.providerId} is not null and ${t.source} = 'argocd'`,
      ),
    uniqueIndex('deployments_unscoped_legacy_sha_uq')
      .on(t.tenantId, t.source, t.sha)
      .where(sql`${t.connectorId} is null and ${t.providerId} is null`),
    // Covers the per-service recent-deploys window read: partition + ORDER BY (deployed_at DESC,
    // id DESC) served straight from the index, scoped by tenant then service.
    index('deployments_tenant_service_deployed_idx').on(
      t.tenantId,
      t.service,
      t.deployedAt.desc(),
      t.id.desc(),
    ),
    // Covers the keyset deploy-history pager: tenant-scoped ORDER BY (deployed_at DESC, id DESC)
    // served straight from the index, across every service (no service predicate, unlike the read above).
    index('deployments_tenant_deployed_idx').on(t.tenantId, t.deployedAt.desc(), t.id.desc()),
    tenantIsolation(),
  ],
);
