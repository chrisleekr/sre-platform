import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { connectorConfigs } from './connectors';
import { memberships, tenants } from './control-plane';
import { incidents } from './incidents';
import { incidentSignals } from './incident-signals';
import { investigationRuns } from './investigation-runs';
import { tenantIsolation } from './rls';

export const SIGNAL_DISPOSITIONS = ['investigate', 'ticket', 'log'] as const;
export type SignalDisposition = (typeof SIGNAL_DISPOSITIONS)[number];

/** Tenant-owned semantic decision for one durable provider event version. */
export const signalDispositions = pgTable(
  'signal_dispositions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceEventKey: text('source_event_key').notNull(),
    sourceEventAt: timestamp('source_event_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    sourceEventVersion: text('source_event_version'),
    signalKey: text('signal_key').notNull(),
    dataSourceId: uuid('data_source_id'),
    surface: text('surface').notNull(),
    channel: text('channel').notNull(),
    threadId: text('thread_id').notNull(),
    summary: text('summary').notNull(),
    reason: text('reason').notNull(),
    service: text('service'),
    severity: text('severity'),
    proposedTitle: text('proposed_title'),
    disposition: text('disposition').$type<SignalDisposition>().notNull(),
    classificationMode: text('classification_mode').notNull().default('shadow'),
    runtimeFingerprint: text('runtime_fingerprint'),
    corpusVersion: text('corpus_version'),
    contractVersion: text('contract_version'),
    effectiveDisposition: text('effective_disposition').$type<SignalDisposition>(),
    correlationDecision: text('correlation_decision'),
    correlatedIncidentId: uuid('correlated_incident_id'),
    correlatedSignalId: uuid('correlated_signal_id'),
    incidentId: uuid('incident_id'),
    action: text('action'),
    safeDeferralReason: text('safe_deferral_reason'),
    riskIfIgnored: text('risk_if_ignored'),
    reviewHorizonMinutes: integer('review_horizon_minutes'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, precision: 3 }),
    supersededAt: timestamp('superseded_at', { withTimezone: true, precision: 3 }),
    reviewStartedAt: timestamp('review_started_at', { withTimezone: true, precision: 3 }),
    promotionSuggestedAt: timestamp('promotion_suggested_at', {
      withTimezone: true,
      precision: 3,
    }),
    promotionPromptClaimId: uuid('promotion_prompt_claim_id'),
    promotionPromptClaimedAt: timestamp('promotion_prompt_claimed_at', {
      withTimezone: true,
      precision: 3,
    }),
    promotedAt: timestamp('promoted_at', { withTimezone: true, precision: 3 }),
    promotedByUserId: uuid('promoted_by_user_id'),
    promotedBySurface: text('promoted_by_surface'),
    promotedByActor: text('promoted_by_actor'),
    promotionCriterion: text('promotion_criterion'),
    promotionReason: text('promotion_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    unique('signal_dispositions_source_event_uq').on(
      table.tenantId,
      table.source,
      table.sourceEventKey,
    ),
    unique('signal_dispositions_tenant_id_uq').on(table.tenantId, table.id),
    uniqueIndex('signal_dispositions_current_signal_uq')
      .on(table.tenantId, table.source, table.signalKey)
      .where(sql`${table.supersededAt} is null`),
    index('signal_dispositions_inbox_idx').on(
      table.tenantId,
      table.disposition,
      table.resolvedAt,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    foreignKey({
      columns: [table.tenantId, table.dataSourceId],
      foreignColumns: [connectorConfigs.tenantId, connectorConfigs.id],
      name: 'signal_dispositions_data_source_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'signal_dispositions_incident_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.correlatedIncidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'signal_dispositions_correlated_incident_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.correlatedSignalId],
      foreignColumns: [incidentSignals.tenantId, incidentSignals.id],
      name: 'signal_dispositions_correlated_signal_fk',
    }),
    foreignKey({
      columns: [table.promotedByUserId, table.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'signal_dispositions_promoter_membership_fk',
    }),
    check('signal_dispositions_vocabulary', sql`disposition in ('investigate', 'ticket', 'log')`),
    check('signal_dispositions_mode', sql`classification_mode in ('shadow', 'enforce')`),
    check(
      'signal_dispositions_effective_vocabulary',
      sql`effective_disposition is null or effective_disposition in ('investigate', 'ticket', 'log')`,
    ),
    check(
      'signal_dispositions_ticket_shape',
      sql`(
        disposition <> 'ticket'
        or (
          action is not null
          and safe_deferral_reason is not null
          and risk_if_ignored is not null
          and review_horizon_minutes between 1 and 10080
        )
      )`,
    ),
    check(
      'signal_dispositions_promotion_shape',
      sql`(
        promoted_at is null
        or (
          disposition = 'ticket'
          and incident_id is not null
          and promoted_by_surface is not null
          and promoted_by_actor is not null
          and promotion_criterion is not null
          and promotion_reason is not null
        )
      )`,
    ),
    tenantIsolation(),
  ],
);

/** Auditable runtime evaluation of the reviewed classifier corpus. */
export const signalDispositionEvaluations = pgTable(
  'signal_disposition_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('queued'),
    jobId: uuid('job_id'),
    corpusVersion: text('corpus_version').notNull(),
    contractVersion: text('contract_version').notNull(),
    runtimeFingerprint: text('runtime_fingerprint').notNull(),
    total: integer('total'),
    correct: integer('correct'),
    criticalSafetyMisses: integer('critical_safety_misses'),
    classMetrics: jsonb('class_metrics'),
    scenarioResults: jsonb('scenario_results'),
    ticketSemanticsReviewedAt: timestamp('ticket_semantics_reviewed_at', {
      withTimezone: true,
      precision: 3,
    }),
    ticketSemanticsReviewedByUserId: uuid('ticket_semantics_reviewed_by_user_id'),
    failureCategory: text('failure_category'),
    requestedByUserId: uuid('requested_by_user_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, precision: 3 }),
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    unique('signal_disposition_evaluations_tenant_id_uq').on(table.tenantId, table.id),
    unique('signal_disposition_evaluations_job_uq').on(table.tenantId, table.jobId),
    index('signal_disposition_evaluations_recent_idx').on(
      table.tenantId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    foreignKey({
      columns: [table.requestedByUserId, table.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'signal_disposition_evaluations_requester_membership_fk',
    }),
    foreignKey({
      columns: [table.ticketSemanticsReviewedByUserId, table.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'signal_disposition_evaluations_reviewer_membership_fk',
    }),
    check(
      'signal_disposition_evaluations_status',
      sql`status in ('queued', 'running', 'completed', 'failed')`,
    ),
    check(
      'signal_disposition_evaluations_active_job',
      sql`status not in ('queued', 'running') or job_id is not null`,
    ),
    check(
      'signal_disposition_evaluations_result_shape',
      sql`(
        status <> 'completed'
        or (
          total is not null and total > 0
          and correct is not null and correct between 0 and total
          and critical_safety_misses is not null and critical_safety_misses >= 0
          and class_metrics is not null
          and scenario_results is not null
          and completed_at is not null
        )
      )`,
    ),
    check(
      'signal_disposition_evaluations_failure_shape',
      sql`status <> 'failed' or (failure_category is not null and completed_at is not null)`,
    ),
    tenantIsolation(),
  ],
);

/** Tenant-visible retention and incident-declaration policy. */
export const tenantSignalPolicies = pgTable(
  'tenant_signal_policies',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    retentionDays: integer('retention_days').notNull().default(30),
    measurementStartedAt: timestamp('measurement_started_at', {
      withTimezone: true,
      precision: 3,
    })
      .defaultNow()
      .notNull(),
    secondTeamEnabled: boolean('second_team_enabled').notNull().default(true),
    customerVisibleEnabled: boolean('customer_visible_enabled').notNull().default(true),
    unsolvedAfterMinutes: integer('unsolved_after_minutes').default(60),
    classificationMode: text('classification_mode').notNull().default('shadow'),
    enforcementApprovedAt: timestamp('enforcement_approved_at', {
      withTimezone: true,
      precision: 3,
    }),
    enforcementApprovedByUserId: uuid('enforcement_approved_by_user_id'),
    approvedEvaluationId: uuid('approved_evaluation_id'),
    approvedCorpusVersion: text('approved_corpus_version'),
    approvedContractVersion: text('approved_contract_version'),
    approvedRuntimeFingerprint: text('approved_runtime_fingerprint'),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    check('tenant_signal_policies_retention', sql`retention_days between 1 and 3650`),
    check(
      'tenant_signal_policies_unsolved',
      sql`unsolved_after_minutes is null or unsolved_after_minutes between 1 and 10080`,
    ),
    check('tenant_signal_policies_mode', sql`classification_mode in ('shadow', 'enforce')`),
    check(
      'tenant_signal_policies_enforcement',
      sql`classification_mode <> 'enforce' or (
        enforcement_approved_at is not null
        and enforcement_approved_by_user_id is not null
        and approved_evaluation_id is not null
        and approved_corpus_version is not null
        and approved_contract_version is not null
        and approved_runtime_fingerprint is not null
      )`,
    ),
    foreignKey({
      columns: [table.enforcementApprovedByUserId, table.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'tenant_signal_policies_approved_by_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.approvedEvaluationId],
      foreignColumns: [signalDispositionEvaluations.tenantId, signalDispositionEvaluations.id],
      name: 'tenant_signal_policies_approved_evaluation_fk',
    }),
    tenantIsolation(),
  ],
);

/** Human-applied free-form incident tag. */
export const incidentTags = pgTable(
  'incident_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    tag: text('tag').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    unique('incident_tags_value_uq').on(table.tenantId, table.incidentId, table.tag),
    unique('incident_tags_tenant_id_uq').on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_tags_incident_fk',
    }),
    foreignKey({
      columns: [table.actorUserId, table.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'incident_tags_actor_membership_fk',
    }),
    check('incident_tags_not_blank', sql`btrim(tag) <> ''`),
    check('incident_tags_length', sql`char_length(tag) <= 128`),
    check('incident_tags_no_whitespace', sql`tag !~ '[[:space:]]'`),
    check('incident_tags_source', sql`source in ('dashboard', 'slack')`),
    tenantIsolation(),
  ],
);

/** Evidence-linked cause proposal awaiting human acceptance or edit. */
export const incidentTagSuggestions = pgTable(
  'incident_tag_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    runId: uuid('run_id').notNull(),
    tag: text('tag').notNull(),
    evidenceIds: uuid('evidence_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    appliedAt: timestamp('applied_at', { withTimezone: true, precision: 3 }),
    appliedTagId: uuid('applied_tag_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    unique('incident_tag_suggestions_run_tag_uq').on(
      table.tenantId,
      table.incidentId,
      table.runId,
      table.tag,
    ),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_tag_suggestions_incident_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.incidentId, table.runId],
      foreignColumns: [
        investigationRuns.tenantId,
        investigationRuns.incidentId,
        investigationRuns.id,
      ],
      name: 'incident_tag_suggestions_run_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.appliedTagId],
      foreignColumns: [incidentTags.tenantId, incidentTags.id],
      name: 'incident_tag_suggestions_applied_tag_fk',
    }),
    check('incident_tag_suggestions_cause', sql`tag like 'cause:%'`),
    check('incident_tag_suggestions_evidence', sql`cardinality(evidence_ids) > 0`),
    tenantIsolation(),
  ],
);

/** Tenant-owned HTTPS link template for one free-form tag prefix. */
export const tenantTagLinkRules = pgTable(
  'tenant_tag_link_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    urlTemplate: text('url_template').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    unique('tenant_tag_link_rules_prefix_uq').on(table.tenantId, table.prefix),
    check('tenant_tag_link_rules_prefix', sql`prefix <> '' and prefix !~ '[[:space:]:]'`),
    tenantIsolation(),
  ],
);
