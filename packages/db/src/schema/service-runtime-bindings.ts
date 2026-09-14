import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { connectorConfigs } from './connectors';
import { services } from './topology';
import { tenantIsolation } from './rls';

/** A confirmed service-to-runtime association, never inferred from equal names. */
export const serviceRuntimeBindings = pgTable(
  'service_runtime_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    serviceName: text('service_name').notNull(),
    connectorId: uuid('connector_id').notNull(),
    namespace: text('namespace').notNull(),
    labelKey: text('label_key').notNull().default(''),
    labelValue: text('label_value').notNull().default(''),
    environment: text('environment').notNull(),
    confirmedByUserId: uuid('confirmed_by_user_id').notNull(),
    rationale: text('rationale').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('service_runtime_binding_scope_uq').on(
      t.tenantId,
      t.connectorId,
      t.namespace,
      t.labelKey,
      t.labelValue,
    ),
    foreignKey({
      columns: [t.tenantId, t.serviceName],
      foreignColumns: [services.tenantId, services.name],
      name: 'runtime_binding_service_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.connectorId],
      foreignColumns: [connectorConfigs.tenantId, connectorConfigs.id],
      name: 'runtime_binding_connector_fk',
    }).onDelete('cascade'),
    check(
      'runtime_binding_nonempty',
      sql`btrim(namespace) <> '' and btrim(environment) <> '' and btrim(rationale) <> ''`,
    ),
    check(
      'runtime_binding_label_pair',
      sql`(label_key = '' and label_value = '') or (btrim(label_key) <> '' and btrim(label_value) <> '')`,
    ),
    tenantIsolation(),
  ],
);
