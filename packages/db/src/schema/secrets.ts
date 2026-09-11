// Per-tenant connector credentials, encrypted in-house and isolated
// by RLS.
import { pgTable, uuid, text, integer, timestamp, unique, customType } from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const tenantSecrets = pgTable(
  'tenant_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    authTag: bytea('auth_tag').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.tenantId, t.name), tenantIsolation()],
);
