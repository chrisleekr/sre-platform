import { sql } from 'drizzle-orm';
import { withTenant, type Executor } from '../rls';
import {
  activeStatusPredicate,
  incidents,
  type IncidentStatus,
  type InvestigationStatus,
} from '../schema';

// IncidentStatus / ACTIVE_STATUSES / CLOSED_STATUSES moved to schema/incidents.ts: the partial
// unique index there is built from ACTIVE_STATUSES, and schema is the dependency leaf, so the vocabulary
// has to live on that side of the edge. Still re-exported from `@sre/db` via the schema barrel.

// Severity ranks, MOST severe first: sev1 outranks sev3. The ordering is not arbitrary and reads
// backwards at a glance — the classify consumer routes its degraded fail-open "at the lowest severity"
// with DEGRADED_SEVERITY = 'sev3' (classify-consumer.ts) — so escalation means a NUMERICALLY LOWER rank.
// A max()/greatest() over these would ratchet the wrong way.
//
// A LOCAL const that MIRRORS the engine's zod enums (apps/triage-worker/src/engine/correlation.ts,
// engine/classify.ts: z.enum(['sev1','sev2','sev3'])), deliberately not imported from them: @sre/db is a
// leaf package and the engine is an app that depends on it, so importing would invert the dependency.
//
// Drift is safe only DOWNWARD: a new LESS severe rank ('sev4') ranks 99 and correctly never escalates.
// A new MORE severe rank ('sev0') would ALSO rank 99, so the worst alert the platform can emit would
// fail to escalate a live sev3 — the exact symptom, silently reappearing at the top of the scale.
// So the mirror is pinned from the engine side, which CAN import both: engine/__tests__/correlation.test.ts asserts
// these keys set-equal the zod enum. Exported for that test only.
export const SEVERITY_ORDER: Record<string, number> = { sev1: 1, sev2: 2, sev3: 3 };
// An unrecognised severity ranks LEAST severe, so it can never escalate over a known rank, and any known
// rank escalates over it. `severity` is free text by design (route-to-incident.ts: "source and severity
// are free text"), so this is a reachable input, not a defensive branch: the column is `text` and
// NewIncident.severity is `string`. Treat unknown as no information, never as a de-escalation.
const UNKNOWN_SEVERITY_RANK = 99;

/** `case <expr> when 'sev1' then 1 ... else 99 end` — a severity expression's rank, as literal sql. */
const severityRank = (expr: string): string =>
  `case ${expr} ${Object.entries(SEVERITY_ORDER)
    .map(([sev, rank]) => `when '${sev}' then ${rank}`)
    .join(' ')} else ${UNKNOWN_SEVERITY_RANK} end`;

/**
 * The severity expression for the incident upsert's ACTIVE-reuse path: a re-alert that ESCALATES
 * raises the incident's severity; anything else leaves it alone.
 *
 * A ratchet, not an overwrite, and it only ever moves toward sev1. The reuse discarded the incoming
 * severity entirely (the set clause was `updatedAt` only), so a re-alert could never raise an incident.
 * A plain overwrite would fix that and break the mirror case: a later, calmer re-fire would walk the
 * incident back down while humans work it at the higher rank.
 *
 * Still NOT reachable as a re-firing ALERT: the push fingerprint hashes the raw event, whose `ts` is fresh
 * per message (classify-consumer.ts), so a worse alert always carries a NEW fingerprint and INSERTs.
 *
 * It IS reachable from the MENTION path, which no longer dedups for 24h before createIncident is
 * reached. The mention path now keys
 * dedup per message, so a follow-up in a thread whose owner is still ACTIVE reaches this upsert on the
 * thread-stable fingerprint whenever the verdict is new_incident. WHICH severity arrives depends on why,
 * and only one of the three routes can actually move the ratchet:
 *  - characterizeThread threw, or the LLM returned an out-of-range belongs_to index: both take the
 *    `fallback` verdict, pinned at DEGRADED_SEVERITY = 'sev3' (classify-consumer.ts). A no-op ONLY
 *    because every owner on a thread-derived fingerprint carries a KNOWN rank: handleMention writes
 *    either the zod enum sev1|sev2|sev3 (engine/correlation.ts) or that same 'sev3', and 3 < {1,2,3} is
 *    false. It is NOT a property of sev3 being the floor. The floor is UNKNOWN_SEVERITY_RANK = 99
 *    (above), so 3 < 99 WOULD fire against a free-text owner, and adding a 'sev4' rank would make 3 < 4
 *    fire against a live sev4. The fail-open fallback is not a model judgment, so if either becomes
 *    reachable this route must be excluded explicitly rather than left to the rank table.
 *  - characterizeThread SUCCEEDED and returned new_incident: either it saw the owner listed and judged
 *    the thread a different problem, or the owner was never shown to it (the candidate set degrades to
 *    empty on a Postgres/embedder blip, and an active set over CAP_N is trimmed to the pgvector top-K).
 *    That verdict carries the model's own sev1|sev2|sev3, so this route alone can escalate the owner,
 *    never de-escalate it. That direction is the point of the ratchet, so it is sound, not a regression.
 * The escalation now persists: that branch used to enqueue a second triage job for the reused incident and
 * 23505 the whole tx away, ratchet included. The funnel skips the job on reuse instead.
 *
 * Alertmanager's bounded episode router now reaches this reuse path when it selects an active workspace.
 * A higher-severity provider episode must escalate, never de-escalate, while humans work the incident.
 *
 * Literal sql (sql.raw over our own compile-time consts, never user input) for the same reason as the
 * schema's status predicates. `excluded` is the proposed row, `incidents` the live one it conflicted with.
 */
const severityRatchet = () =>
  sql.raw(`case
    when ${severityRank('excluded.severity')} < ${severityRank('incidents.severity')}
      then excluded.severity
    else incidents.severity end`);

export interface NewIncident {
  fingerprint: string;
  alertSource: string;
  service: string;
  severity: string;
  /** Short human-readable title (relevance classifier / mention). Persisted at create, folds. */
  title?: string;
  purpose?: 'incident' | 'health_check';
  deployCorrelated?: boolean;
  deployFingerprint?: string;
  /** Initial operational lifecycle; defaults to open. */
  status?: IncidentStatus;
  /** Initial agent work state; defaults to queued. */
  investigationStatus?: InvestigationStatus;
}

export interface CreatedIncident {
  id: string;
  /** True when the upsert conflicted and REUSED a live incident instead of inserting a new one. */
  reused: boolean;
}

/**
 * Creates incident.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function createIncident(
  exec: Executor,
  tenantId: string,
  input: NewIncident,
): Promise<CreatedIncident> {
  return withTenant(exec, tenantId, async (tx) => {
    const rows = await tx
      .insert(incidents)
      // Trusted tenantId last: a field on `input` can never override the session tenant. Lifecycle
      // defaults to open; callers may independently seed degraded investigation progress.
      .values({
        ...input,
        status: input.status ?? 'open',
        investigationStatus: input.investigationStatus ?? 'queued',
        tenantId,
      })
      .onConflictDoUpdate({
        target: [incidents.tenantId, incidents.fingerprint],
        // The arbiter is the PARTIAL index incidents_active_fingerprint_uq, and Postgres infers a partial
        // index only from an inference clause that restates its predicate — without targetWhere this call
        // raises 42P10 ("no unique or exclusion constraint matching the ON CONFLICT specification"), since
        // the bare (tenant_id, fingerprint) pair no longer has a full unique to match. Same helper as the
        // index itself, so the two expressions are identical by construction. (`targetWhere` is the
        // current drizzle-orm spelling; the bare `where` on this config is deprecated.)
        targetWhere: activeStatusPredicate(),
        // Severity RATCHETS on reuse — see severityRatchet. What is NOT here is equally deliberate:
        //  - occurrence_count: bumpIncidentOccurrenceOnce owns it, guarded by the inbound_side_effects
        //    ledger, because the classify stream is at-least-once and a bare `+ 1` here would
        // double-count on every redelivery — the exact bug closed.
        // - title: the LLM correlation path owns it; a re-alert's title is not an update.
        set: { severity: severityRatchet(), updatedAt: sql`now()` },
      })
      // INSERT-or-REUSE, decided by the row's own xmax rather than by comparing timestamps or re-reading:
      // one statement, no race. A tuple produced by a genuine INSERT has xmax = 0; ON CONFLICT DO UPDATE
      // self-locks the tuple it updates, so the reuse path always reports non-zero (a concurrent KEY SHARE
      // locker only turns that into a MultiXactId, still non-zero), and no locker can reach a tuple that
      // exists solely inside this uncommitted statement.
      //
      // This is a Postgres IMPLEMENTATION DETAIL, not a documented contract, and worse: the xmax the DO
      // UPDATE path carries forward has been proposed for REMOVAL as unnecessary work (Andres Freund,
      // pgsql-hackers, 2019-07-24, "ON CONFLICT (and manual row locks) cause xmax of updated tuple to
      // unnecessarily be set"). If that ever lands, the reuse path returns xmax = 0 and this detector
      // INVERTS SILENTLY: `reused:false` on every reuse, which is again (a 23505 dead-letter, or two
      // LLM investigations narrating into one customer thread). Nothing else would fail first.
      //
      // The tripwire is incident-repo.test.ts, which pins both directions against a real
      // Postgres. It only covers the major the test container runs (pg16, vitest.global-setup.ts), so it
      // cannot warn about a major we do not yet run.
      // ON UPGRADE: PG18+ adds OLD/NEW output aliases to RETURNING, which is the replacement to reach for.
      // `OLD IS NULL` separates the two paths HERE only because it is a row-wise test (true when the row is
      // null or all its fields are null) and `id` is NOT NULL, so an updated OLD row can never read all-null.
      // That reasoning is ours: the PG18 docs give no insert-vs-update idiom. Pin it against a real Postgres before switching.
      //
      // Rejected: `created_at = updated_at`. created_at is timestamp(3) and updated_at timestamp(6), so one
      // now() rounds to ms while the other keeps µs and a genuine INSERT reads created_at <> updated_at
      // almost always: a detector that reports `reused` for nearly every create.
      //
      // The system column is table-qualified only to say out loud WHICH row's xmax this is. Nothing is
      // shadowing it: `excluded` is in scope in ON CONFLICT DO UPDATE's SET/WHERE, not in RETURNING, so a
      // bare `xmax` would resolve to incidents.xmax and behave identically. The qualifier is style.
      .returning({ id: incidents.id, inserted: sql<boolean>`("incidents".xmax = 0)` });
    const row = rows[0]!;
    return { id: row.id, reused: !row.inserted };
  });
}
