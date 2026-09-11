// The durable ledger of NON-idempotent side effects already applied for an inbound surface message
//Under RLS.
//
// The occurrence bump is a bare `occurrence_count + 1` UPDATE: it cannot be made idempotent on its
// own, and the classify stream is at-least-once. A Valkey reservation cannot close the gap —
// it is released on a THROW, and a SIGKILL (OOM, task replacement) is not a throw, so the redelivered
// job would see the reservation, skip the bump, and ACK. Postgres is the durable source of truth: the
// ledger row and the bump commit in ONE transaction, so a crash rolls back both and the redelivery
// correctly retries.
import { pgTable, uuid, text, timestamp, unique, foreignKey } from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { incidents } from './incidents';
import { tenantIsolation } from './rls';

export const inboundSideEffects = pgTable(
  'inbound_side_effects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // The surface message the side effect was applied for: `slack:<channel>:<ts>`. Channel-scoped, since
    // a Slack `ts` is unique within a CHANNEL, not within a workspace.
    messageKey: text('message_key').notNull(),
    incidentId: uuid('incident_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The idempotency key: the INSERT ... ON CONFLICT DO NOTHING is what decides whether this delivery
    // owns the side effect.
    unique('inbound_side_effects_message_uq').on(t.tenantId, t.messageKey),
    // Tenant-scoped incident FK: RI checks bypass RLS, so a plain incident_id FK would leak a
    // cross-tenant existence oracle. References incidents_tenant_id_uq. [pattern]
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'inbound_side_effects_incident_fk',
    }),
    tenantIsolation(),
  ],
);
