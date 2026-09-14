import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ObservedTopologyFact,
  TopologyCollection,
  TopologyEntity,
  TopologyRelation,
  TopologyScanProgress,
} from '@sre/contracts';
import { connectorConfigs } from './connectors';
import { tenantIsolation } from './rls';

/** Last-good resource evidence is durable even while its provider is unavailable. */
export const topologyCollections = pgTable(
  'topology_collections',
  {
    tenantId: uuid('tenant_id').notNull(),
    connectorId: uuid('connector_id').notNull(),
    generation: integer('generation').notNull(),
    key: text('key').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    completeness: text('completeness').$type<TopologyCollection['completeness']>().notNull(),
    issue: text('issue').$type<TopologyCollection['issue']>(),
    entities: jsonb('entities').$type<ObservedTopologyFact<TopologyEntity>[]>().notNull(),
    relations: jsonb('relations').$type<ObservedTopologyFact<TopologyRelation>[]>().notNull(),
    scan: jsonb('scan').$type<TopologyScanProgress & { startedAt: string }>(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.connectorId, t.key] }),
    foreignKey({
      columns: [t.tenantId, t.connectorId],
      foreignColumns: [connectorConfigs.tenantId, connectorConfigs.id],
      name: 'topology_collection_connector_fk',
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);
