// The mutable "working post" a surface adapter maintains per bound conversation.
// Each linked thread needs its own message id when the active conversation changes during a recurrence.
import { pgTable, uuid, text, timestamp, unique, foreignKey } from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';
import { surfaceBindings } from './surfaces';

export const surfaceWorkingPosts = pgTable(
  'surface_working_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bindingId: uuid('binding_id').notNull(),
    // The surface's mutable message id (e.g. Slack ts) the adapter edits/deletes in place.
    messageTs: text('message_ts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('surface_working_posts_uq').on(t.tenantId, t.bindingId),
    foreignKey({
      columns: [t.tenantId, t.bindingId],
      foreignColumns: [surfaceBindings.tenantId, surfaceBindings.id],
      name: 'surface_working_posts_binding_fk',
    }),
    tenantIsolation(),
  ],
);
