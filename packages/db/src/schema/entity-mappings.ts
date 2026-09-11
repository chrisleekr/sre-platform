import type { EntityKind } from '@sre/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, tenants } from './control-plane';
import { tenantIsolation } from './rls';
import { services } from './topology';

/** Human-confirmed translation from a provider entity identity to the tenant service catalog. */
export const entityServiceMappings = pgTable(
  'entity_service_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    candidateKey: text('candidate_key').notNull(),
    candidateKind: text('candidate_kind').$type<EntityKind>().notNull(),
    serviceName: text('service_name').notNull(),
    source: text('source').notNull().default('human'),
    confirmedByUserId: uuid('confirmed_by_user_id').notNull(),
    rationale: text('rationale').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('entity_service_mappings_candidate_uq').on(t.tenantId, t.candidateKey),
    index('entity_service_mappings_service_idx').on(t.tenantId, t.serviceName),
    foreignKey({
      columns: [t.tenantId, t.serviceName],
      foreignColumns: [services.tenantId, services.name],
      name: 'entity_service_mappings_service_fk',
    }),
    foreignKey({
      columns: [t.confirmedByUserId, t.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'entity_service_mappings_membership_fk',
    }),
    check('entity_service_mappings_source_vocabulary', sql`${t.source} = 'human'`),
    check('entity_service_mappings_rationale_not_blank', sql`btrim(${t.rationale}) <> ''`),
    tenantIsolation(),
  ],
);
