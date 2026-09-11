import type { IncidentFeedbackDecision, IncidentFeedbackTarget } from '@sre/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, tenants } from './control-plane';
import { incidents } from './incidents';
import { tenantIsolation } from './rls';

/** Append-only, attributed responder feedback on investigation decisions. */
export const incidentFeedback = pgTable(
  'incident_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    targetType: text('target_type').$type<IncidentFeedbackTarget>().notNull(),
    targetId: text('target_id').notNull(),
    decision: text('decision').$type<IncidentFeedbackDecision>().notNull(),
    rationale: text('rationale').notNull(),
    correction: jsonb('correction').$type<Record<string, unknown>>(),
    createdByUserId: uuid('created_by_user_id').notNull(),
    revision: integer('revision').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_feedback_incident_fk',
    }),
    foreignKey({
      columns: [t.createdByUserId, t.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'incident_feedback_membership_fk',
    }),
    index('incident_feedback_incident_created_idx').on(t.tenantId, t.incidentId, t.createdAt),
    index('incident_feedback_actor_created_idx').on(t.tenantId, t.createdByUserId, t.createdAt),
    index('incident_feedback_target_idx').on(t.tenantId, t.targetType, t.targetId),
    uniqueIndex('incident_feedback_target_revision_uq').on(
      t.tenantId,
      t.targetType,
      t.targetId,
      t.revision,
    ),
    check(
      'incident_feedback_target_decision_vocabulary',
      sql`(
        (${t.targetType} = 'finding' and ${t.decision} in ('confirm', 'correct'))
        or (${t.targetType} = 'entity' and ${t.decision} in ('confirm', 'correct'))
        or (${t.targetType} = 'correlation' and ${t.decision} in ('group', 'separate'))
        or (${t.targetType} = 'noise' and ${t.decision} in ('noise', 'not_noise'))
      )`,
    ),
    check('incident_feedback_target_not_blank', sql`btrim(${t.targetId}) <> ''`),
    check('incident_feedback_rationale_not_blank', sql`btrim(${t.rationale}) <> ''`),
    tenantIsolation(),
  ],
);
