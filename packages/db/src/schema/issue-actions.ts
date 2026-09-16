import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { IssueActionView, IssueChanges, RepositoryIssue } from '@sre/contracts';
import { tenants, users } from './control-plane';
import { incidents } from './incidents';
import { tenantIsolation } from './rls';

/** An immutable preview and its single dispatch attempt, separate from advisory approvals. */
export const issueActions = pgTable(
  'issue_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    connectorId: uuid('connector_id').notNull(),
    connectorVersion: integer('connector_version').notNull(),
    repository: text('repository').notNull(),
    repositoryId: text('repository_id').notNull(),
    destination: jsonb('destination').$type<IssueActionView['destination']>().notNull(),
    number: integer('number'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    requestKey: text('request_key').notNull(),
    changes: jsonb('changes').$type<IssueChanges>().notNull(),
    before: jsonb('before').$type<RepositoryIssue>(),
    status: text('status').$type<IssueActionView['status']>().notNull().default('draft'),
    result: jsonb('result').$type<RepositoryIssue>(),
    error: text('error'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('issue_actions_request_uq').on(t.tenantId, t.incidentId, t.requestKey),
    index('issue_actions_incident_idx').on(t.tenantId, t.incidentId, t.createdAt),
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'issue_actions_incident_fk',
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);
