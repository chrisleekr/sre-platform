import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { incidents } from './incidents';
import { tenantIsolation } from './rls';

export const INVESTIGATION_SUBJECT_KINDS = [
  'infrastructure_resource',
  'deployment',
  'connector_verification',
  'topology_service',
] as const;
export type InvestigationSubjectKind = (typeof INVESTIGATION_SUBJECT_KINDS)[number];
export type InvestigationSubjectState = 'firing' | 'unknown' | 'resolved';
export type InvestigationSubjectSnapshot = Record<string, unknown>;

/** Server-resolved, bounded provenance for an incident declared from platform-owned evidence. */
export const investigationSubjects = pgTable(
  'investigation_subjects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    kind: text('kind').$type<InvestigationSubjectKind>().notNull(),
    sourceId: text('source_id').notNull(),
    subjectId: text('subject_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    sourcePath: text('source_path').notNull(),
    capturedState: text('captured_state').$type<InvestigationSubjectState>().notNull(),
    capturedSummary: text('captured_summary').notNull(),
    capturedSnapshot: jsonb('captured_snapshot').$type<InvestigationSubjectSnapshot>().notNull(),
    capturedHash: text('captured_hash').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, precision: 3 }).notNull(),
    currentState: text('current_state').$type<InvestigationSubjectState>().notNull(),
    currentSummary: text('current_summary').notNull(),
    currentSnapshot: jsonb('current_snapshot').$type<InvestigationSubjectSnapshot>().notNull(),
    currentHash: text('current_hash').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, precision: 3 }).notNull(),
    syncEnabled: boolean('sync_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'investigation_subjects_incident_fk',
    }),
    unique('investigation_subjects_incident_uq').on(t.tenantId, t.incidentId),
    index('investigation_subjects_fingerprint_idx').on(t.tenantId, t.fingerprint),
    index('investigation_subjects_identity_idx').on(t.tenantId, t.kind, t.sourceId, t.subjectId),
    check(
      'investigation_subjects_kind_vocabulary',
      sql`kind in ('infrastructure_resource', 'deployment', 'connector_verification', 'topology_service')`,
    ),
    check(
      'investigation_subjects_captured_state_vocabulary',
      sql`captured_state in ('firing', 'unknown', 'resolved')`,
    ),
    check(
      'investigation_subjects_current_state_vocabulary',
      sql`current_state in ('firing', 'unknown', 'resolved')`,
    ),
    tenantIsolation(),
  ],
);
