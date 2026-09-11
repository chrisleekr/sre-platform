// Files attached to an incident's conversation (e.g. a Slack upload the human dropped in the
// thread), optionally tied to the message that carried them. Under RLS. `interpretation` holds the
// vision model's read of the file, filled in a later phase; null until then.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { incidents } from './incidents';
import { incidentMessages } from './incident-messages';
import { tenantIsolation } from './rls';

export const incidentAttachments = pgTable(
  'incident_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    // The hub message that carried the attachment; null when attached outside a specific message.
    messageId: uuid('message_id'),
    fileId: text('file_id').notNull(),
    name: text('name').notNull(),
    mimetype: text('mimetype').notNull(),
    urlPrivate: text('url_private').notNull(),
    permalink: text('permalink'),
    // Vision model's interpretation of the file; filled in a later phase, null until then.
    interpretation: text('interpretation'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('incident_attachments_incident_idx').on(t.tenantId, t.incidentId),
    // Tenant-scoped lookup path for resolving an attachment by its source file id.
    index('incident_attachments_file_idx').on(t.tenantId, t.fileId),
    // Idempotency anchor: one attachment row per (tenant, incident, source file),
    // so a redelivered inbound message re-recording the same file is an ON CONFLICT DO NOTHING no-op
    // rather than a duplicate. Tenant-scoped like every unique here so the key can never span tenants.
    uniqueIndex('incident_attachments_tenant_incident_file_uq').on(
      t.tenantId,
      t.incidentId,
      t.fileId,
    ),
    // Tenant-scoped incident FK: RI checks bypass RLS, so a plain incident_id FK would let one
    // tenant reference/probe another tenant's incident. [pattern]
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_attachments_incident_fk',
    }),
    // Tenant-scoped message FK, same rationale — references incident_messages_tenant_id_uq.
    foreignKey({
      columns: [t.tenantId, t.messageId],
      foreignColumns: [incidentMessages.tenantId, incidentMessages.id],
      name: 'incident_attachments_message_fk',
    }),
    tenantIsolation(),
  ],
);
