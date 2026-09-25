// Durable work-queue source-of-truth. System-level: the worker dispatches
// across all tenants, so this table is NOT under per-request RLS and carries no
// tenant_isolation policy. tenant_id is carried for downstream tenant context, not for
// request-time isolation. (It is exempted in migrate.ts NON_RLS_TENANT_TABLES.)
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

// The job lifecycle: enqueued -> claimed by a consumer -> terminal (completed, or dead-lettered past
// retryableMaxAttempts). A status outside this set escapes the coalescing predicates below, which is how
// a CLAIMED job silently leaves its index and lets a retry insert a DUPLICATE triage job: two LLM
// investigations narrating into one customer thread. The CHECK makes that unrepresentable.
// The type is DERIVED from the array, never hand-written beside it: the array is what generates both the
// CHECK and the index predicates, so deriving makes "the type and the constraint agree" true by
// construction rather than by convention. Hand-written, a status added to the union and missed in the
// array would compile clean and then 23514 on its first write.
export const JOB_STATUSES = ['queued', 'processing', 'done', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * `status = 'x'` / `status IN ('x','y')` as LITERAL sql, for the partial-index predicates and the status
 * CHECK below. Literal for the same two reasons as incidents' activeStatusPredicate: DDL cannot carry
 * bind parameters, and the source is our own compile-time union, never user input.
 *
 * A function, not a shared const: each call site gets its own SQL instance rather than aliasing one.
 *
 * The two spellings are load-bearing, not cosmetic. drizzle-kit diffs the index predicate as a STRING
 * against the stored snapshot, so a rendering that is merely equivalent ('status in (...)' for a single
 * status) reads as a changed index and churns a DROP/CREATE INDEX into the next migration. These
 * reproduce the checked-in snapshot byte for byte.
 */
const jobStatusPredicate = (statuses: readonly JobStatus[]) =>
  sql.raw(
    statuses.length === 1
      ? `status = '${statuses[0]}'`
      : `status IN (${statuses.map((s) => `'${s}'`).join(',')})`,
  );

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    // Free text BY CONTRACT, and deliberately un-CHECKed: enqueue writes JobInput.type verbatim
    // (queue.ts), production carries 'poll' alongside 'triage'/'resume'/'runbook.generate', and tests
    // enqueue randomized types. A vocabulary CHECK here would break every one of them.
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    // Durable classify idempotency. The receipt key heals a retry of the same accepted delivery; the
    // provider event key coalesces the same event when a transport produces more than one receipt.
    // Nullable because other queue types do not have an inbound provider identity.
    idempotencyKey: text('idempotency_key'),
    eventKey: text('event_key'),
    // The JobStatus vocabulary — see the type above rather than a list here, which is exactly the comment
    // -only guard that let a test seed `status:'running'` (a status this queue has never had).
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    // The Valkey stream this job was enqueued onto. Set at enqueue and never changed. reconcile and
    // the handleOne guard scope on it so a queue only ever re-dispatches or completes its own jobs;
    // without it a shared-table reconcile misroutes other streams' stuck jobs. Distinct from
    // stream_id (the per-entry XADD id, which is lost on a crash before XADD).
    stream: text('stream').notNull(),
    streamId: text('stream_id'),
    // Durable delayed execution. Producers leave future work undispatched until available_at; consumers
    // repeat the same due-time predicate at claim so an early or forged stream pointer cannot run it.
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('jobs_status_idx').on(t.status),
    index('jobs_due_idx').on(t.stream, t.status, t.availableAt),
    // Fair-scheduling index: backs ClassifyQueue's fair-select, which on every classify delivery
    // (a) aggregates each tenant's most-recent non-queued updated_at within a window (the `served` CTE)
    // and (b) scans queued rows ordered by that last-served time. Leading (stream, status) matches both
    // the `stream = classify AND status <> 'queued'` served scan and the `stream = classify AND
    // status = 'queued'` outer scan; tenant_id + updated_at carry the per-tenant MAX and the ordering.
    index('jobs_classify_fair_idx').on(t.stream, t.status, t.tenantId, t.updatedAt),
    uniqueIndex('jobs_classify_idempotency_uq')
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`type = 'classify' AND idempotency_key IS NOT NULL`),
    uniqueIndex('jobs_classify_event_uq')
      .on(t.tenantId, t.eventKey)
      .where(sql`type = 'classify' AND event_key IS NOT NULL`),
    uniqueIndex('jobs_founding_live_uq')
      .on(t.tenantId, t.idempotencyKey)
      .where(
        sql`type = 'founding.provision' AND status IN ('queued', 'processing') AND idempotency_key IS NOT NULL`,
      ),
    uniqueIndex('jobs_tenant_purge_live_uq')
      .on(sql`(payload->>'tenantId')`)
      .where(sql`type = 'tenant.purge' AND status IN ('queued', 'processing')`),
    // Resume-coalescing partial-unique index: at most one queued `resume` job per
    // (tenant, incident) so a reply-flood cannot fan out into N queued triage runs.
    // Predicate is `status = 'queued'` ONLY, not queued+processing: at claim the job leaves the index
    // (queued -> processing), so a human reply that lands MID-RUN enqueues a fresh queued resume
    // instead of being coalesced into the running job it post-dates (the engine lock serializes the
    // two runs; the second reads full history). Covering 'processing' too would give the durable index
    // a longer lifetime than the clear-at-claim gate, dropping the mid-run reply and orphaning the gate.
    // Fan-out stays bounded: at most one 'processing' + one 'queued' resume per incident.
    uniqueIndex('jobs_resume_coalesce_idx')
      .on(t.tenantId, t.type, sql`(payload->>'incidentId')`)
      .where(jobStatusPredicate(['queued'])),
    // Runbook-coalescing partial-unique index: at most one queued OR PROCESSING
    // `runbook.generate` job per (tenant, incident), so a double-clicked generate button cannot run the
    // distiller twice and write duplicate knowledge_chunks (the consumer's findChunkLinkingIncident
    // guard is a read, so two concurrent runs both pass it).
    // Type lives in the PREDICATE, not the key: the resume index above is deliberately queued-only so a
    // mid-run reply enqueues a fresh resume, and widening its shared key to 'processing' would break
    // that. Runbook generation has the opposite requirement — a second request that post-dates a RUNNING
    // generation is a duplicate, not new work — so it needs its own predicate, scoped to its own type.
    // Regeneration stays possible: a done/dead job leaves the index.
    uniqueIndex('jobs_runbook_coalesce_idx')
      .on(t.tenantId, sql`(payload->>'incidentId')`)
      .where(sql`type = 'runbook.generate' AND ${jobStatusPredicate(['queued', 'processing'])}`),
    // Same contract as the runbook index for the two other human-commanded generations:
    // a double-clicked Generate postmortem, or a second grade request that post-dates a RUNNING grade,
    // is a duplicate and must not pay for a second LLM run. Queued OR processing, type in the predicate.
    uniqueIndex('jobs_postmortem_coalesce_idx')
      .on(t.tenantId, sql`(payload->>'incidentId')`)
      .where(sql`type = 'postmortem.generate' AND ${jobStatusPredicate(['queued', 'processing'])}`),
    uniqueIndex('jobs_assessment_grade_coalesce_idx')
      .on(t.tenantId, sql`(payload->>'incidentId')`)
      .where(sql`type = 'assessment.grade' AND ${jobStatusPredicate(['queued', 'processing'])}`),
    uniqueIndex('jobs_cohort_analysis_coalesce_idx')
      .on(t.tenantId, sql`(payload->>'cohortId')`)
      .where(sql`type = 'cohort.analyze' AND ${jobStatusPredicate(['queued'])}`),
    uniqueIndex('jobs_relation_reassessment_coalesce_idx')
      .on(t.tenantId, sql`(payload->>'incidentId')`)
      .where(sql`type = 'relation.reassess' AND ${jobStatusPredicate(['queued'])}`),
    // One queued topology pass per (tenant, connector). Every pass reads live provider state, so a
    // second queued pass adds load and no information. Without this the five-minute scheduler stacked
    // passes behind the single serial consumer, and the backlog kept it re-reading providers
    // back to back. Queued-only: a pass arriving mid-run still queues one successor, and a stranded
    // processing row never blocks new work.
    uniqueIndex('jobs_topology_discover_coalesce_idx')
      .on(t.tenantId, sql`(payload->>'connectorId')`)
      .where(sql`type = 'topology.discover' AND ${jobStatusPredicate(['queued'])}`),
    // The vocabulary guard, derived from the same const as the predicates above so a status can never be
    // legal to write yet invisible to the index that must coalesce it.
    check('jobs_status_vocabulary', jobStatusPredicate(JOB_STATUSES)),
  ],
);
