import { sql } from 'drizzle-orm';
import { foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants, users } from './control-plane';
import { incidents } from './incidents';
import { incidentMessages } from './incident-messages';
import { tenantIsolation } from './rls';

/** Capture-only consent, separate from approvals for human execution of recommendations. */
export const knowledgeCaptureProposals = pgTable(
  'knowledge_capture_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    sourceMessageId: uuid('source_message_id').notNull(),
    offerMessageId: uuid('offer_message_id').notNull(),
    fenceMessageId: uuid('fence_message_id').notNull(),
    status: text('status')
      .$type<'pending' | 'consumed' | 'cancelled' | 'expired' | 'superseded'>()
      .notNull()
      .default('pending'),
    consumedMessageId: uuid('consumed_message_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '15 minutes'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('knowledge_capture_proposals_source_uq').on(t.tenantId, t.sourceMessageId),
    index('knowledge_capture_proposals_pending_idx').on(t.tenantId, t.incidentId, t.status),
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'knowledge_capture_proposals_incident_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.sourceMessageId],
      foreignColumns: [incidentMessages.tenantId, incidentMessages.id],
      name: 'knowledge_capture_proposals_source_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.offerMessageId],
      foreignColumns: [incidentMessages.tenantId, incidentMessages.id],
      name: 'knowledge_capture_proposals_offer_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.fenceMessageId],
      foreignColumns: [incidentMessages.tenantId, incidentMessages.id],
      name: 'knowledge_capture_proposals_fence_fk',
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);
