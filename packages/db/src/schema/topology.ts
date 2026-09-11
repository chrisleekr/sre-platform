// The service dependency graph (Postgres adjacency list + recursive CTE, no Neo4j).
// Foundation for blast radius. Under RLS.
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // The canonical service identifier: the same free-text value carried in `incidents.service`
    // and the connector `service` param. Blast radius maps an incident's service to this node.
    name: text('name').notNull(),
    team: text('team'),
    // tier1 | tier2 | tier3 — informs blast-radius severity and on-call routing.
    criticality: text('criticality'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('services_tenant_name_uq').on(t.tenantId, t.name), tenantIsolation()],
);

export const serviceDependencies = pgTable(
  'service_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // `upstream` depends on / calls `downstream`: if `downstream` fails, `upstream` is in the blast
    // radius. Blast-radius traversal walks from the affected service up the `downstream->upstream`
    // direction to find who is affected.
    upstream: text('upstream').notNull(),
    downstream: text('downstream').notNull(),
    // sync | async — an async edge insulates the caller from a downstream failure (tiering).
    syncType: text('sync_type').notNull().default('sync'),
    // A circuit breaker on the edge insulates the caller from a downstream failure (tiering).
    circuitBreaker: boolean('circuit_breaker').notNull().default(false),
    protocol: text('protocol'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('service_deps_edge_uq').on(t.tenantId, t.upstream, t.downstream),
    // A service cannot depend on itself: meaningless, and a degenerate cycle that would trap the
    // blast-radius recursive CTE. Guards every writer, not just the API.
    check('service_deps_no_self_loop', sql`upstream <> downstream`),
    // An edge can only reference registered services (graph integrity). The tenant_id is part of each
    // FK so it stays same-tenant. FK checks bypass RLS, but the composite key still binds to the
    // edge's own tenant, and RLS on insert (WITH CHECK) pins the edge to the session tenant.
    foreignKey({
      columns: [t.tenantId, t.upstream],
      foreignColumns: [services.tenantId, services.name],
      name: 'service_deps_upstream_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.downstream],
      foreignColumns: [services.tenantId, services.name],
      name: 'service_deps_downstream_fk',
    }),
    tenantIsolation(),
  ],
);
