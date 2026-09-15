import { foreignKey, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants, memberships } from './control-plane';
import { incidents } from './incidents';
import { services } from './topology';
import { tenantIsolation } from './rls';

/** An explicit affected-service decision also works when the provider supplied no entity candidate. */
export const incidentServiceAssignments = pgTable(
  'incident_service_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    serviceName: text('service_name').notNull(),
    confirmedByUserId: uuid('confirmed_by_user_id').notNull(),
    rationale: text('rationale').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('incident_service_assignment_uq').on(t.tenantId, t.incidentId, t.serviceName),
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_service_assignment_incident_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.serviceName],
      foreignColumns: [services.tenantId, services.name],
      name: 'incident_service_assignment_service_fk',
    }),
    foreignKey({
      columns: [t.confirmedByUserId, t.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'incident_service_assignment_actor_fk',
    }),
    tenantIsolation(),
  ],
);
