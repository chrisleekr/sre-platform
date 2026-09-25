// The incident — the central tenant-scoped record triage and the conversation attach to.
// Under RLS. The engine session reference is provider-agnostic.
import type {
  RecoveryQuestion,
  InvestigationGap,
  ResolutionPolicy,
  ResolutionBasis,
} from '@sre/contracts';
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
  vector,
} from 'drizzle-orm/pg-core';
import { EMBED_DIM } from '../embedder';
import { tenants } from './control-plane';
import { investigationRuns } from './investigation-runs';
import { tenantIsolation } from './rls';

// Operational lifecycle and investigation progress are independent. A monitoring signal clearing,
// an agent finishing evidence gathering, and a responder closing the case are three different facts.
// Keeping them in one status made Slack, the dashboard, correlation, and the worker disagree.
export type IncidentStatus = (typeof ACTIVE_STATUSES)[number] | (typeof CLOSED_STATUSES)[number];
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];
export type IncidentPurpose = 'incident' | 'health_check';

// The status vocabulary lives HERE, in the schema leaf, rather than in incident-repo: the partial index
// below is built from ACTIVE_STATUSES, and incident-repo imports these back via './schema'. Defining
// them in incident-repo instead would need schema -> incident-repo -> schema, a real runtime cycle.
// One definition, so the index predicate and the queries that read it cannot drift apart.

// Lifecycle states that still represent a live operational case. Mitigated remains active until an
// explicit transition resolves or closes it. These constants also drive the active fingerprint index.
export const ACTIVE_STATUSES = ['open', 'mitigated'] as const;
// Resolved records completion under the configured policy or an explicit operator decision.
// Closed means post-incident work is finished or a human explicitly files the case.
// Both leave the active correlation window.
export const CLOSED_STATUSES = ['resolved', 'closed'] as const;

// The agent's work state. `degraded` means the configured provider could not complete the investigation;
// it says nothing about whether the service is healthy or whether responders closed the incident.
export const INVESTIGATION_STATUSES = ['queued', 'gathering', 'assessed', 'degraded'] as const;
export const RECOVERY_STATES = ['verifying', 'monitoring', 'verified', 'not_verified'] as const;
export type RecoveryState = (typeof RECOVERY_STATES)[number];
export const HYPOTHESIS_STATES = ['leading', 'plausible', 'disfavored', 'disproven'] as const;
export type HypothesisState = (typeof HYPOTHESIS_STATES)[number];
export interface RankedHypothesisRecord {
  hypothesis: string;
  confidence: number;
  evidence: string;
  state?: HypothesisState;
  supportingEvidenceIds?: string[];
  contradictingEvidenceIds?: string[];
}

/**
 * Builds the SQL predicate for active incident statuses.
 *
 * @param alias - Optional SQL table alias used by the predicate.
 */
export const activeStatusPredicate = (alias?: string) =>
  sql.raw(
    `${alias ? `${alias}.` : ''}status in (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  );

/**
 * `status IN (<every status>)` as LITERAL sql, for the vocabulary CHECK below. Same literal-sql reasoning
 * as activeStatusPredicate, and likewise a function so each call site gets its own SQL instance.
 *
 * DERIVED from the two status consts, never hand-written: the CHECK exists precisely to close the trap
 * documented on incidents_active_fingerprint_uq, and a hand-written literal list would re-arm that trap
 * one line below the comment warning about it — the CHECK would then be the thing that drifts, and it
 * would reject a status the application legitimately writes. The two sets partition every status, so
 * their union is the whole vocabulary by construction.
 */
const statusVocabularyPredicate = () =>
  sql.raw(
    `status in (${[...ACTIVE_STATUSES, ...CLOSED_STATUSES].map((s) => `'${s}'`).join(', ')})`,
  );

const investigationStatusVocabularyPredicate = () =>
  sql.raw(`investigation_status in (${INVESTIGATION_STATUSES.map((s) => `'${s}'`).join(', ')})`);

const recoveryStateVocabularyPredicate = () =>
  sql.raw(`recovery_state in (${RECOVERY_STATES.map((s) => `'${s}'`).join(', ')})`);

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    alertSource: text('alert_source').notNull(),
    service: text('service').notNull(),
    severity: text('severity').notNull(),
    // Short human-readable title from normalized provider evidence or incident characterization.
    // Historical records can remain null until their signal-derived title is repaired.
    title: text('title'),
    resolutionPolicy: text('resolution_policy')
      .$type<ResolutionPolicy>()
      .notNull()
      .default('verified_recovery'),
    resolutionBasis: text('resolution_basis').$type<ResolutionBasis>(),
    purpose: text('purpose').$type<IncidentPurpose>().notNull().default('incident'),
    // Operational lifecycle only. Investigation progress is the independent column below.
    status: text('status').$type<IncidentStatus>().notNull().default('open'),
    investigationStatus: text('investigation_status')
      .$type<InvestigationStatus>()
      .notNull()
      .default('queued'),
    // Optimistic fence for delayed recovery jobs and surface projections. Every lifecycle transition
    // increments it; automation applies only to the version it observed.
    lifecycleVersion: integer('lifecycle_version').notNull().default(0),
    // Correlation shortlist embedding of the scrubbed seed text. Nullable: seeded
    // best-effort at open, so a missing vector degrades to the in-context active set, never a failure.
    embedding: vector('embedding', { dimensions: EMBED_DIM }),
    // Recurrence tally: incremented when an AUTOMATED (bot) message correlates to this incident
    // (a chronic flapper), instead of waking the engine. Defaults to 1 on create.
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    // Immutable hard stop for provider episode grouping. This belongs to the incident because responders
    // can move signal rows between incidents during merge and split corrections.
    correlationMaxAgeAt: timestamp('correlation_max_age_at', {
      withTimezone: true,
      precision: 3,
    }),
    deployCorrelated: boolean('deploy_correlated').notNull().default(false),
    deployFingerprint: text('deploy_fingerprint'),
    engineProvider: text('engine_provider'),
    engineSessionId: text('engine_session_id'),
    // The provider model that produced the triage result (e.g. claude-opus-4-8); null until triaged.
    engineModel: text('engine_model'),
    rcaSummary: text('rca_summary'),
    confidence: integer('confidence'),
    // Ranked root-cause hypotheses with evidence, when the engine emits them; null otherwise.
    rankedHypotheses: jsonb('ranked_hypotheses').$type<RankedHypothesisRecord[]>(),
    currentState: text('current_state'),
    impact: text('impact'),
    assessmentEvidenceIds: uuid('assessment_evidence_ids').array(),
    // Explicit unresolved questions and next diagnostic step. These are model-produced assessment
    // fields, not inferred from prose in the dashboard. Null means this incident predates the structured
    // assessment contract; an empty array means the latest assessment reported no known unknowns.
    unknowns: jsonb('unknowns').$type<InvestigationGap[]>(),
    nextStep: text('next_step'),
    // Separate from updated_at: incident activity, severity changes, and recurrence also touch updated_at.
    // The dashboard uses this timestamp only for the structured assessment's freshness label.
    assessmentUpdatedAt: timestamp('assessment_updated_at', { withTimezone: true }),
    trustedAssessmentRunId: uuid('trusted_assessment_run_id'),
    // Recovery is neither provider signal state nor incident lifecycle. Keeping the worker's factual
    // result structured stops the dashboard from guessing "verified" by parsing an agent paragraph.
    recoveryState: text('recovery_state').$type<RecoveryState>(),
    recoverySummary: text('recovery_summary'),
    recoveryEvidenceIds: uuid('recovery_evidence_ids').array(),
    recoveryUnknowns: jsonb('recovery_unknowns').$type<string[]>(),
    recoveryQuestions: jsonb('recovery_questions').$type<RecoveryQuestion[]>(),
    recoveryQuestionsUpdatedAt: timestamp('recovery_questions_updated_at', { withTimezone: true }),
    recoveryNextStep: text('recovery_next_step'),
    recoveryUpdatedAt: timestamp('recovery_updated_at', { withTimezone: true }),
    /** Investigation run that exclusively owns the transient `verifying` state. */
    recoveryRunId: uuid('recovery_run_id'),
    // Model-directed recovery monitoring. attempt counts completed checks in the current cleared-signal
    // cycle; next_check_at and its reason are present only while another durable check is scheduled.
    recoveryAttempt: integer('recovery_attempt'),
    recoveryMaxChecks: integer('recovery_max_checks'),
    recoveryNextCheckAt: timestamp('recovery_next_check_at', { withTimezone: true }),
    recoveryScheduleReason: text('recovery_schedule_reason'),
    // The hub id of the human reply whose resume last applied to this incident. Enables
    // exactly-once resume (redelivery is a no-op) and stops a late triage from overwriting a resume
    // RCA. Null until the first resume applies.
    lastResumeMessageId: text('last_resume_message_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    mitigatedAt: timestamp('mitigated_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    // Archival removes a terminal incident from day-to-day queues without rewriting its operational
    // lifecycle or deleting its audit record. Null means the incident is visible in regular queues.
    archivedAt: timestamp('archived_at', { withTimezone: true, precision: 3 }),
    // precision:3 (ms) so the keyset `before` cursor, which round-trips created_at through a JS Date (ms)
    // via toISOString(), can never skip a row that shares a millisecond but differs in µs. Mirrors
    // incident_messages.createdAt, which pins the same precision for the hub keyset reader.
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      'incidents_resolution_policy_check',
      sql`${t.resolutionPolicy} in ('verified_recovery', 'provider_clear')`,
    ),
    check(
      'incidents_resolution_basis_check',
      sql`${t.resolutionBasis} in ('verified_recovery', 'provider_clear', 'operator')`,
    ),
    check(
      'incidents_health_check_policy_check',
      sql`${t.purpose} <> 'health_check' or ${t.resolutionPolicy} = 'verified_recovery'`,
    ),
    // Exactly one ACTIVE incident per (tenant, fingerprint) — a correlation WINDOW, not a permanent
    // claim on the fingerprint. A full unique here (what this replaced) made the window eternal: a
    // fingerprint's incident, once resolved or closed, still blocked the next occurrence's INSERT, so the
    // upsert handed back the terminal row. The funnel would then keep that row's OLD
    // surface binding (surface_bindings_incident_uq -> onConflictDoNothing) and answer in a thread
    // nobody is reading. The predicate frees terminal rows to accumulate as history while still
    // forbidding two live incidents for one fingerprint.
    //
    // Alertmanager reaches this invariant through its bounded provider-episode router. The adapter opens
    // a new root after lifecycle or time bounds close instead of reusing terminal history.
    //
    // The trap this comment used to describe — `status` was plain text with no CHECK, so a typo'd status
    // ('Open', 'investigatng') fell outside this predicate, escaped the index entirely, and silently
    // permitted a second "active" incident — is closed by incidents_status_vocabulary below, which now
    // rejects the typo at write time. The directive stands regardless, because the CHECK bounds the
    // vocabulary but cannot decide which statuses are ACTIVE: widen the vocabulary only via
    // ACTIVE_STATUSES above, never by hand-writing a status literal here.
    uniqueIndex('incidents_active_fingerprint_uq')
      .on(t.tenantId, t.fingerprint)
      .where(activeStatusPredicate()),
    // The vocabulary guard, derived from ACTIVE_STATUSES + CLOSED_STATUSES. Guards every writer, not just
    // the repo: a status this application has no code to ever leave is a stuck incident.
    check('incidents_status_vocabulary', statusVocabularyPredicate()),
    check('incidents_purpose_vocabulary', sql`purpose in ('incident', 'health_check')`),
    check('incidents_investigation_status_vocabulary', investigationStatusVocabularyPredicate()),
    // CHECK accepts NULL as unknown; non-null values are bounded to the recovery vocabulary.
    check('incidents_recovery_state_vocabulary', recoveryStateVocabularyPredicate()),
    // Composite unique so tenant-scoped children (surface_bindings, approvals) can FK
    // (tenant_id, incident_id) -> here: referential-integrity checks bypass RLS, so a plain
    // incident_id FK would let one tenant reference/probe another tenant's incident.
    unique('incidents_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.id, t.trustedAssessmentRunId],
      foreignColumns: [
        investigationRuns.tenantId,
        investigationRuns.incidentId,
        investigationRuns.id,
      ],
      name: 'incidents_trusted_assessment_run_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.id, t.recoveryRunId],
      foreignColumns: [
        investigationRuns.tenantId,
        investigationRuns.incidentId,
        investigationRuns.id,
      ],
      name: 'incidents_recovery_run_fk',
    }),
    // Correlation shortlist: HNSW over the cosine opclass, matching the `<=>` operator the
    // shortlist query ranks with. An L2/btree index here would rank by the wrong distance.
    index('incidents_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    // Keyset pagination for visible closed incidents: the page reader orders by
    // (created_at desc, id desc) within a tenant, so this composite matches the sort + cursor predicate.
    index('incidents_tenant_created_id_idx').on(t.tenantId, t.createdAt.desc(), t.id.desc()),
    // Every user-facing queue excludes tombstones; the broader index supports internal retention work.
    index('incidents_tenant_archived_created_id_idx').on(
      t.tenantId,
      t.archivedAt,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    tenantIsolation(),
  ],
);
