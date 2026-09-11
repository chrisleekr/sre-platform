import type { IncidentCorrelationFeedback } from '@sre/contracts';
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
import { tenants } from './control-plane';
import { incidents, type IncidentStatus } from './incidents';
import { investigationRuns } from './investigation-runs';
import { tenantIsolation } from './rls';

export const INCIDENT_RELATION_TYPES = [
  'possible_related',
  'caused_by',
  'recurrence_of',
  'merged_into',
  'split_from',
  'unrelated',
] as const;
export type IncidentRelationType = (typeof INCIDENT_RELATION_TYPES)[number];

export const INCIDENT_RELATION_DECIDERS = ['system', 'agent', 'human'] as const;
export type IncidentRelationDecider = (typeof INCIDENT_RELATION_DECIDERS)[number];

/** Versioned evidence for a reversible relationship decision between two distinct incidents. */
export const incidentRelations = pgTable(
  'incident_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sourceIncidentId: uuid('source_incident_id').notNull(),
    targetIncidentId: uuid('target_incident_id').notNull(),
    type: text('type').$type<IncidentRelationType>().notNull(),
    rationale: text('rationale').notNull(),
    evidence: jsonb('evidence').$type<string[]>().notNull().default([]),
    evidenceIds: uuid('evidence_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    confidence: integer('confidence'),
    decisionRunId: uuid('decision_run_id'),
    correction: jsonb('correction').$type<{
      signalIds: string[];
      bindingIds: string[];
      primaryBindingId: string;
      sourceLifecycle: {
        status: IncidentStatus;
        resolvedAt: string | null;
        closedAt: string | null;
      };
    }>(),
    correlationFeedback: jsonb('correlation_feedback').$type<IncidentCorrelationFeedback>(),
    decidedBy: text('decided_by').$type<IncidentRelationDecider>().notNull(),
    decidedByUserId: uuid('decided_by_user_id'),
    supersededAt: timestamp('superseded_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.sourceIncidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_relations_source_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.targetIncidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_relations_target_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.decisionRunId],
      foreignColumns: [investigationRuns.tenantId, investigationRuns.id],
      name: 'incident_relations_decision_run_fk',
    }),
    uniqueIndex('incident_relations_active_uq')
      .on(t.tenantId, t.sourceIncidentId, t.targetIncidentId, t.type)
      .where(sql`${t.supersededAt} is null`),
    index('incident_relations_target_idx').on(t.tenantId, t.targetIncidentId, t.createdAt),
    uniqueIndex('incident_relations_active_causal_parent_uq')
      .on(t.tenantId, t.sourceIncidentId)
      .where(sql`${t.type} = 'caused_by' and ${t.supersededAt} is null`),
    index('incident_relations_correlation_feedback_idx')
      .using('gin', t.correlationFeedback)
      .where(sql`${t.correlationFeedback} is not null and ${t.supersededAt} is null`),
    check(
      'incident_relations_type_vocabulary',
      sql`type in ('possible_related', 'caused_by', 'recurrence_of', 'merged_into', 'split_from', 'unrelated')`,
    ),
    check('incident_relations_decider_vocabulary', sql`decided_by in ('system', 'agent', 'human')`),
    check(
      'incident_relations_correlation_feedback_shape',
      sql`${t.correlationFeedback} is null or coalesce((
        ${t.decidedBy} = 'human'
        and ${t.decidedByUserId} is not null
        and jsonb_typeof(${t.correlationFeedback}) = 'object'
        and ${t.correlationFeedback}->>'decision' in ('group', 'separate')
        and jsonb_typeof(${t.correlationFeedback}->'sourceScopeKeys') = 'array'
        and jsonb_typeof(${t.correlationFeedback}->'targetScopeKeys') = 'array'
        and jsonb_typeof(${t.correlationFeedback}->'sharedScopeKeys') = 'array'
        and not jsonb_path_exists(${t.correlationFeedback}, '$.sourceScopeKeys[*] ? (@.type() != "string")')
        and not jsonb_path_exists(${t.correlationFeedback}, '$.targetScopeKeys[*] ? (@.type() != "string")')
        and not jsonb_path_exists(${t.correlationFeedback}, '$.sharedScopeKeys[*] ? (@.type() != "string")')
      ), false)`,
    ),
    check('incident_relations_distinct_incidents', sql`source_incident_id <> target_incident_id`),
    check(
      'incident_relations_confidence_range',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 100)`,
    ),
    check(
      'incident_relations_agent_causal_evidence',
      sql`${t.type} <> 'caused_by' or ${t.decidedBy} <> 'agent' or (${t.decisionRunId} is not null and ${t.confidence} is not null and cardinality(${t.evidenceIds}) > 0)`,
    ),
    tenantIsolation(),
  ],
);
