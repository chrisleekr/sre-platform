// Auto-attribution cache: maps a surface's author id (e.g. a Slack user id) to a resolved
// platform user, so a later reply reuses the mapping without another users.info round-trip. Under RLS;
// tenant binding is via the RLS policy, not a composite FK — users has no tenant_id, so author_user_id
// is a plain FK. author_user_id is NOT NULL here: only a successful resolution is cached (a miss is not
// persisted, so the next reply retries).
import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants, users } from './control-plane';
import { tenantIsolation } from './rls';

export const surfaceIdentities = pgTable(
  'surface_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // e.g. slack
    surface: text('surface').notNull(),
    // The surface's own author id, e.g. a Slack user id.
    surfaceUserId: text('surface_user_id').notNull(),
    // The resolved platform user. Plain FK (users is non-tenant); tenant isolation is via RLS.
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id),
    // How the mapping was established: 'auto' (email match) today; 'manual' reserved for an operator override.
    source: text('source').notNull().default('auto'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('surface_identities_tenant_surface_user_uq').on(t.tenantId, t.surface, t.surfaceUserId),
    tenantIsolation(),
  ],
);
