import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { slos, sloBurnEvents } from './schema';

// Objective definition and burn-event storage. Tenant scoping is by RLS (withTenant sets
// app.tenant_id); tenant_id is written on insert so the RLS WITH CHECK binds the row to the session.
// Only definitions and computed burn events are stored: there is no SLI sample table.

export type SliType = 'availability' | 'latency';

/** A new objective as the CRUD boundary supplies it. */
export interface NewSlo {
  name: string;
  service: string;
  sliType: SliType;
  target: number;
  windowDays: number;
  thresholdMs?: number | null;
  metricQuery: string;
  connectorType: string;
  enabled?: boolean;
}

/** A partial update; any omitted field is left unchanged. */
export type SloPatch = Partial<NewSlo>;

/** One computed burn event to append to an objective's history. */
export interface NewBurnEvent {
  sloId: string;
  budgetPct: number;
  burnRate: number;
  window: string;
}

/** Raised when a tenant already holds its maximum number of objectives. */
export class SloLimitReachedError extends Error {
  constructor(readonly limit: number) {
    super(`objective limit reached (max ${limit})`);
    this.name = 'SloLimitReachedError';
  }
}

// The ceiling is counted and enforced inside the insert transaction rather than by the caller.
// Counting first and inserting afterwards is a read-then-write: two concurrent creates both observe a
// count below the ceiling and both insert. The advisory lock is transaction scoped, so it releases on
// commit or rollback, and it is keyed per tenant, so tenants never wait on each other.
/**
 * Creates one objective for a tenant and returns the stored row.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated objective definition to store.
 * @param maxPerTenant - Ceiling on objectives this tenant may hold.
 * @throws SloLimitReachedError when the tenant is already at the ceiling.
 */
export async function createSlo(db: Db, tenantId: string, input: NewSlo, maxPerTenant: number) {
  return withTenant(db, tenantId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`slo-create:${tenantId}`}, 0))`,
    );
    const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(slos);
    if ((counted?.n ?? 0) >= maxPerTenant) throw new SloLimitReachedError(maxPerTenant);
    const rows = await tx
      .insert(slos)
      .values({
        tenantId,
        name: input.name,
        service: input.service,
        sliType: input.sliType,
        target: input.target,
        windowDays: input.windowDays,
        thresholdMs: input.thresholdMs ?? null,
        metricQuery: input.metricQuery,
        connectorType: input.connectorType,
        enabled: input.enabled ?? true,
      })
      .returning();
    return rows[0]!;
  });
}

/**
 * Lists every objective the tenant owns, enabled and disabled, ordered by name.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 */
export async function listSlos(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) => tx.select().from(slos).orderBy(slos.name));
}

/**
 * Lists only the enabled objectives, which are the ones the scheduled evaluator fans out over.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 */
export async function listEnabledSlos(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx.select().from(slos).where(eq(slos.enabled, true)).orderBy(slos.name),
  );
}

/**
 * Lists the enabled objectives targeting one service, ordered by name.
 *
 * @remarks Disabled objectives are excluded: the evaluator stops refreshing them, so their last budget is stale.
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param service - Canonical service the objectives target.
 */
export async function listSlosByService(db: Db, tenantId: string, service: string) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(slos)
      .where(and(eq(slos.service, service), eq(slos.enabled, true)))
      .orderBy(slos.name),
  );
}

/**
 * Reads one objective by id, or undefined when the tenant does not own it.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Objective identifier to read.
 */
export async function getSlo(db: Db, tenantId: string, id: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.select().from(slos).where(eq(slos.id, id)).limit(1);
    return rows[0];
  });
}

/**
 * Applies a partial update and bumps the modification timestamp, returning the row or undefined.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Objective identifier to update.
 * @param patch - Fields to change; omitted fields are left alone.
 */
export async function updateSlo(db: Db, tenantId: string, id: string, patch: SloPatch) {
  return withTenant(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.service !== undefined) set.service = patch.service;
    if (patch.sliType !== undefined) set.sliType = patch.sliType;
    if (patch.target !== undefined) set.target = patch.target;
    if (patch.windowDays !== undefined) set.windowDays = patch.windowDays;
    if (patch.thresholdMs !== undefined) set.thresholdMs = patch.thresholdMs;
    if (patch.metricQuery !== undefined) set.metricQuery = patch.metricQuery;
    if (patch.connectorType !== undefined) set.connectorType = patch.connectorType;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const rows = await tx.update(slos).set(set).where(eq(slos.id, id)).returning();
    return rows[0];
  });
}

/**
 * Deletes one objective, cascading its burn-event history, and reports whether a row was removed.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Objective identifier to delete.
 */
export async function deleteSlo(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.delete(slos).where(eq(slos.id, id)).returning({ id: slos.id });
    return rows.length > 0;
  });
}

/**
 * Appends one burn event to an objective's history.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Computed budget and burn figures to store.
 */
export async function recordBurnEvent(db: Db, tenantId: string, input: NewBurnEvent) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(sloBurnEvents)
      .values({
        tenantId,
        sloId: input.sloId,
        budgetPct: input.budgetPct,
        burnRate: input.burnRate,
        window: input.window,
      })
      .returning();
    return rows[0]!;
  });
}

/**
 * Longest failure message stored on an objective. The text comes from a tenant's own metrics backend,
 * which can answer with a whole HTML error page, and this column is read on every dashboard poll.
 */
export const MAX_EVAL_ERROR_LEN = 500;

// The only write the evaluator makes to a definition, and what makes a failing objective visible:
// evaluation is best-effort, so a rejected query writes no burn event and would otherwise look
// identical to an objective that has never run. Passing null on success clears a previous failure, so
// a transient outage does not mark the objective broken forever. The message is truncated here; the
// caller scrubs it, because a backend error can quote the request that produced it.
//
// Writes ONLY when the outcome changes, which is why the predicate carries `is distinct from` rather
// than the caller comparing first. `slos` is a definition table: an unconditional write would make a
// healthy tenant update every objective every window, rewriting a small table hundreds of times a day
// to store what it already said. `is distinct from` is null-aware, so clearing and re-raising both
// count as changes while a repeated identical failure does not, and the timestamp therefore means
// "since this failure was first seen" rather than "last attempted".
/**
 * Records the outcome of one evaluation attempt, writing only when it differs from the stored one.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param sloId - Objective whose attempt is being recorded.
 * @param error - Scrubbed failure message, or null when the attempt succeeded.
 * @returns True when the stored outcome changed.
 */
export async function recordEvalOutcome(
  db: Db,
  tenantId: string,
  sloId: string,
  error: string | null,
): Promise<boolean> {
  const message = error === null ? null : error.slice(0, MAX_EVAL_ERROR_LEN);
  return withTenant(db, tenantId, async (tx) => {
    const changed = await tx
      .update(slos)
      .set({
        lastEvalError: message,
        // The two columns always agree: a cleared failure has no start time.
        evalFailingSince: message === null ? null : sql`now()`,
      })
      .where(and(eq(slos.id, sloId), sql`${slos.lastEvalError} is distinct from ${message}`))
      .returning({ id: slos.id });
    return changed.length > 0;
  });
}

// The evaluator appends one row per objective every few minutes forever, so without this the table
// grows with a tenant's age. The bound matches the read window, so nothing this removes was reachable
// by any caller. Capped per call so no single delete holds a long transaction or a large lock set: the
// caller sizes the cap above one sweep interval's accumulation, which keeps it ahead of the inflow and
// still drains a backlog over successive sweeps. The count is returned so a caller can see that.
/**
 * Deletes burn events older than the retention window for one tenant, newest rows untouched.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param olderThanDays - Age beyond which an event is unreachable and may be removed.
 * @param limit - Maximum rows to remove in this call.
 */
export async function pruneBurnEvents(
  db: Db,
  tenantId: string,
  olderThanDays: number,
  limit: number,
): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    // The subquery runs in the same tenant-bound transaction, so it can only ever select this
    // tenant's rows. Ordering oldest-first makes a capped sweep drain the backlog deterministically.
    const doomed = tx
      .select({ id: sloBurnEvents.id })
      .from(sloBurnEvents)
      .where(lt(sloBurnEvents.computedAt, sql`now() - ${`${olderThanDays} days`}::interval`))
      .orderBy(sloBurnEvents.computedAt)
      .limit(limit);
    // Ids are returned only to count them, which is why the caller passes a bounded limit rather
    // than sweeping the whole backlog in one statement.
    const removed = await tx
      .delete(sloBurnEvents)
      .where(inArray(sloBurnEvents.id, doomed))
      .returning({ id: sloBurnEvents.id });
    return removed.length;
  });
}

/**
 * How far back the burn-event read scans. The evaluator appends one row per objective every few
 * minutes, so an unbounded read would grow with a tenant's age rather than with what the callers
 * need: they only ever want the latest event per objective. 90 days is
 * deliberately generous against the longest documented compliance window of 30 days, so even an
 * objective whose evaluator has been down for weeks still resolves to its last real result instead
 * of silently reading as never-evaluated. Widen it here if a use case needs deeper history.
 *
 * The retention sweep uses this same bound, so nothing it removes was readable here. Widening the
 * window without widening the sweep is safe; narrowing it without narrowing the sweep is not.
 */
export const BURN_EVENT_WINDOW_DAYS = 90;

/** One persisted burn event. */
export interface BurnEventRow {
  id: string;
  sloId: string;
  budgetPct: number;
  burnRate: number;
  window: string;
  computedAt: Date;
}

/**
 * Reads the most recent burn events for each of several objectives in one query, newest-first.
 *
 * @remarks A windowed row_number caps each partition, so N objectives cost one round trip, not N. The
 * scan is also bounded in time, so an event older than the retention window is not readable here.
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param sloIds - Objectives to read; an empty list short-circuits to an empty map.
 * @param perSloLimit - Maximum events returned for each objective.
 */
export async function recentBurnEventsForSlos(
  db: Db,
  tenantId: string,
  sloIds: string[],
  perSloLimit: number,
): Promise<Map<string, BurnEventRow[]>> {
  const grouped = new Map<string, BurnEventRow[]>();
  if (sloIds.length === 0) return grouped;
  return withTenant(db, tenantId, async (tx) => {
    const ranked = tx.$with('ranked').as(
      tx
        .select({
          id: sloBurnEvents.id,
          sloId: sloBurnEvents.sloId,
          budgetPct: sloBurnEvents.budgetPct,
          burnRate: sloBurnEvents.burnRate,
          window: sloBurnEvents.window,
          computedAt: sloBurnEvents.computedAt,
          rn: sql<number>`row_number() over (partition by ${sloBurnEvents.sloId} order by ${sloBurnEvents.computedAt} desc)`.as(
            'rn',
          ),
        })
        .from(sloBurnEvents)
        .where(
          and(
            inArray(sloBurnEvents.sloId, sloIds),
            // Bind the window as a text interval literal so there is no untyped-parameter
            // operator-resolution ambiguity. The (tenant, slo, computed_at) index already serves it.
            gte(
              sloBurnEvents.computedAt,
              sql`now() - ${`${BURN_EVENT_WINDOW_DAYS} days`}::interval`,
            ),
          ),
        ),
    );
    const rows = await tx
      .with(ranked)
      .select({
        id: ranked.id,
        sloId: ranked.sloId,
        budgetPct: ranked.budgetPct,
        burnRate: ranked.burnRate,
        window: ranked.window,
        computedAt: ranked.computedAt,
      })
      .from(ranked)
      .where(lte(ranked.rn, perSloLimit))
      .orderBy(ranked.sloId, desc(ranked.computedAt));
    for (const row of rows) {
      const list = grouped.get(row.sloId);
      if (list) list.push(row);
      else grouped.set(row.sloId, [row]);
    }
    return grouped;
  });
}
