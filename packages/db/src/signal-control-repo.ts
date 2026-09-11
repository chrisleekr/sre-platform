import {
  SEMANTIC_DISPOSITION_CONTRACT_VERSION,
  SIGNAL_DISPOSITION_CORPUS_VERSION,
  scrubSecrets,
} from '@sre/contracts';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { signalDispositions, tenantSignalPolicies, type SignalDisposition } from './schema';
import { getTenantSignalPolicy } from './signal-policy-repo';

const MAX_TEXT = 2_000;
const MAX_REASON = 1_000;

export interface SignalTicketFields {
  action: string;
  safeDeferralReason: string;
  riskIfIgnored: string;
  reviewHorizonMinutes: number;
}

export interface NewSignalDisposition {
  source: string;
  sourceEventKey: string;
  sourceEventAt: Date;
  sourceEventVersion?: string | null;
  signalKey: string;
  dataSourceId?: string | null;
  surface: string;
  channel: string;
  threadId: string;
  summary: string;
  reason: string;
  service?: string | null;
  severity?: string | null;
  proposedTitle?: string | null;
  disposition: SignalDisposition;
  correlationDecision?: string | null;
  correlatedIncidentId?: string | null;
  correlatedSignalId?: string | null;
  incidentId?: string | null;
  ticket?: SignalTicketFields | null;
  classificationMode?: 'shadow' | 'enforce';
  runtimeFingerprint?: string | null;
  corpusVersion?: string | null;
  contractVersion?: string | null;
  effectiveDisposition?: SignalDisposition | null;
}

export interface SignalPageCursor {
  createdAt: Date;
  id: string;
}

export interface SignalListOptions {
  limit: number;
  disposition?: SignalDisposition;
  currentOnly?: boolean;
  openOnly?: boolean;
  before?: SignalPageCursor;
}

/** SQL predicate shared by every ticket action and reminder path. */
export const actionableSignalTicketFilter = () =>
  and(
    eq(signalDispositions.disposition, 'ticket'),
    eq(signalDispositions.classificationMode, 'enforce'),
    eq(signalDispositions.effectiveDisposition, 'ticket'),
    isNull(signalDispositions.supersededAt),
    isNull(signalDispositions.resolvedAt),
    isNull(signalDispositions.incidentId),
    isNull(signalDispositions.correlatedIncidentId),
  );

/**
 * Pure response guard matching the authoritative database ticket predicate.
 * @param row - Persisted signal disposition.
 */
export function isActionableSignalTicket(row: typeof signalDispositions.$inferSelect): boolean {
  return (
    row.disposition === 'ticket' &&
    row.classificationMode === 'enforce' &&
    row.effectiveDisposition === 'ticket' &&
    row.supersededAt === null &&
    row.resolvedAt === null &&
    row.incidentId === null &&
    row.correlatedIncidentId === null
  );
}

function bounded(value: string, max: number, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return normalized;
}

function boundedProjection(value: string, max: number, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized.slice(0, max);
}

function ticketValues(input: NewSignalDisposition): SignalTicketFields | null {
  if (input.disposition !== 'ticket') return null;
  if (!input.ticket) throw new Error('ticket details are required');
  const horizon = input.ticket.reviewHorizonMinutes;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 10_080)
    throw new Error('ticket review horizon must be between 1 and 10080 minutes');
  return {
    action: bounded(scrubSecrets(input.ticket.action), MAX_TEXT, 'ticket action'),
    safeDeferralReason: bounded(
      scrubSecrets(input.ticket.safeDeferralReason),
      MAX_TEXT,
      'safe deferral reason',
    ),
    riskIfIgnored: bounded(scrubSecrets(input.ticket.riskIfIgnored), MAX_TEXT, 'risk if ignored'),
    reviewHorizonMinutes: horizon,
  };
}

function sourceEventOrder(eventAt: Date, eventVersion?: string | null): bigint {
  if (eventVersion) {
    try {
      return BigInt(eventVersion);
    } catch {
      // Provider-neutral versions may be opaque; receipt time remains the ordering boundary.
    }
  }
  return BigInt(eventAt.getTime()) * 1_000n + 999n;
}

/**
 * Persists one scrubbed outcome and supersedes the prior signal version.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param input - Validated semantic outcome.
 */
export async function recordSignalDisposition(
  db: Db,
  tenantId: string,
  input: NewSignalDisposition,
) {
  const ticket = ticketValues(input);
  if (!Number.isFinite(input.sourceEventAt.getTime()))
    throw new Error('source event time is invalid');
  const values = {
    tenantId,
    source: bounded(input.source, 100, 'source'),
    sourceEventKey: bounded(input.sourceEventKey, 500, 'source event key'),
    sourceEventAt: input.sourceEventAt,
    sourceEventVersion: input.sourceEventVersion?.trim() || null,
    signalKey: bounded(input.signalKey, 500, 'signal key'),
    dataSourceId: input.dataSourceId ?? null,
    surface: bounded(input.surface, 100, 'surface'),
    channel: bounded(input.channel, 500, 'channel'),
    threadId: bounded(input.threadId, 500, 'thread id'),
    summary: boundedProjection(scrubSecrets(input.summary), MAX_TEXT, 'summary'),
    reason: boundedProjection(scrubSecrets(input.reason), MAX_REASON, 'reason'),
    service: input.service ? scrubSecrets(input.service).trim() || null : null,
    severity: input.severity?.trim() || null,
    proposedTitle: input.proposedTitle
      ? scrubSecrets(input.proposedTitle).trim().slice(0, 200) || null
      : null,
    disposition: input.disposition,
    classificationMode: input.classificationMode ?? 'shadow',
    runtimeFingerprint: input.runtimeFingerprint?.trim() || null,
    corpusVersion: input.corpusVersion?.trim() || null,
    contractVersion: input.contractVersion?.trim() || null,
    effectiveDisposition: input.effectiveDisposition ?? null,
    correlationDecision: input.correlationDecision ?? null,
    correlatedIncidentId: input.correlatedIncidentId ?? null,
    correlatedSignalId: input.correlatedSignalId ?? null,
    incidentId: input.incidentId ?? null,
    action: ticket?.action ?? null,
    safeDeferralReason: ticket?.safeDeferralReason ?? null,
    riskIfIgnored: ticket?.riskIfIgnored ?? null,
    reviewHorizonMinutes: ticket?.reviewHorizonMinutes ?? null,
  };
  return withTenant(db, tenantId, async (tx) => {
    await tx.insert(tenantSignalPolicies).values({ tenantId }).onConflictDoNothing();
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`signal-disposition:${tenantId}:${values.source}:${values.signalKey}`}, 0))`,
    );
    const existing = await tx
      .select()
      .from(signalDispositions)
      .where(
        and(
          eq(signalDispositions.source, values.source),
          eq(signalDispositions.sourceEventKey, values.sourceEventKey),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];
    const current = await tx
      .select()
      .from(signalDispositions)
      .where(
        and(
          eq(signalDispositions.source, values.source),
          eq(signalDispositions.signalKey, values.signalKey),
          isNull(signalDispositions.supersededAt),
        ),
      )
      .limit(1);
    const incomingOrder = sourceEventOrder(values.sourceEventAt, values.sourceEventVersion);
    const currentOrder = current[0]
      ? sourceEventOrder(current[0].sourceEventAt, current[0].sourceEventVersion)
      : null;
    const stale =
      currentOrder !== null &&
      (currentOrder > incomingOrder ||
        (currentOrder === incomingOrder && current[0]!.sourceEventKey >= values.sourceEventKey));
    if (!stale) {
      await tx
        .update(signalDispositions)
        .set({ supersededAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(signalDispositions.source, values.source),
            eq(signalDispositions.signalKey, values.signalKey),
            isNull(signalDispositions.supersededAt),
          ),
        );
    }
    const inserted = await tx
      .insert(signalDispositions)
      .values({ ...values, supersededAt: stale ? new Date() : null })
      .returning();
    return inserted[0]!;
  });
}

/**
 * Reads the canonical durable decision for one provider-event version.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param source - Stable signal source.
 * @param sourceEventKey - Stable provider-event version.
 */
export function findSignalDispositionBySourceEvent(
  db: Db,
  tenantId: string,
  source: string,
  sourceEventKey: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(signalDispositions)
      .where(
        and(
          eq(signalDispositions.source, source),
          eq(signalDispositions.sourceEventKey, sourceEventKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Lists bounded tenant-visible outcomes newest first.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param options - Filters and page size.
 */
export function listSignalDispositions(db: Db, tenantId: string, options: SignalListOptions) {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit)));
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(signalDispositions)
      .where(
        and(
          options.disposition ? eq(signalDispositions.disposition, options.disposition) : undefined,
          options.currentOnly === false ? undefined : isNull(signalDispositions.supersededAt),
          options.openOnly
            ? and(isNull(signalDispositions.incidentId), isNull(signalDispositions.resolvedAt))
            : undefined,
          options.before
            ? or(
                lt(signalDispositions.createdAt, options.before.createdAt),
                and(
                  eq(signalDispositions.createdAt, options.before.createdAt),
                  lt(signalDispositions.id, options.before.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(signalDispositions.createdAt), desc(signalDispositions.id))
      .limit(limit),
  );
}

/**
 * Lists a stable keyset page without hiding older actionable tickets.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param options - Filters, page size, and optional keyset cursor.
 */
export async function listSignalDispositionPage(
  db: Db,
  tenantId: string,
  options: SignalListOptions,
): Promise<{
  signals: Array<typeof signalDispositions.$inferSelect>;
  nextCursor: SignalPageCursor | null;
}> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit)));
  const rows = await listSignalDispositions(db, tenantId, { ...options, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const signals = rows.slice(0, limit);
  const last = signals.at(-1);
  return {
    signals,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

/**
 * Deletes one bounded expired-outcome batch.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param options - Clock and batch bound.
 */
export async function sweepExpiredSignalDispositions(
  db: Db,
  tenantId: string,
  options: { now?: Date; limit: number },
): Promise<number> {
  const policy = await getTenantSignalPolicy(db, tenantId);
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - policy.retentionDays * 86_400_000);
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit)));
  return withTenant(db, tenantId, async (tx) => {
    const candidates = await tx
      .select({ id: signalDispositions.id })
      .from(signalDispositions)
      .where(lt(signalDispositions.createdAt, cutoff))
      .orderBy(asc(signalDispositions.createdAt), asc(signalDispositions.id))
      .limit(limit);
    if (candidates.length === 0) return 0;
    const deleted = await tx
      .delete(signalDispositions)
      .where(
        inArray(
          signalDispositions.id,
          candidates.map((row) => row.id),
        ),
      )
      .returning({ id: signalDispositions.id });
    return deleted.length;
  });
}

/**
 * Records the Incident that successfully received a semantically correlated signal.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param source - Stable signal source.
 * @param sourceEventKey - Stable provider-event version.
 * @param incidentId - Incident that received the signal.
 */
export function linkSignalDispositionIncident(
  db: Db,
  tenantId: string,
  source: string,
  sourceEventKey: string,
  incidentId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(signalDispositions)
      .set({ incidentId, updatedAt: sql`now()` })
      .where(
        and(
          eq(signalDispositions.source, source),
          eq(signalDispositions.sourceEventKey, sourceEventKey),
          isNull(signalDispositions.incidentId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  });
}

/**
 * Reads one tenant-owned outcome.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param signalId - Outcome identifier.
 */
export function getSignalDisposition(db: Db, tenantId: string, signalId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(signalDispositions)
      .where(eq(signalDispositions.id, signalId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Records the decision that actually controlled routing beside a shadow proposal.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param source - Stable signal source.
 * @param sourceEventKey - Stable provider-event version.
 * @param disposition - Effective routing disposition.
 */
export function markSignalEffectiveDisposition(
  db: Db,
  tenantId: string,
  source: string,
  sourceEventKey: string,
  disposition: SignalDisposition,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(signalDispositions)
      .set({ effectiveDisposition: disposition, updatedAt: sql`now()` })
      .where(
        and(
          eq(signalDispositions.source, source),
          eq(signalDispositions.sourceEventKey, sourceEventKey),
        ),
      )
      .returning();
    return rows[0] ?? null;
  });
}

/**
 * Marks a suppressing disposition only while its exact enforcement approval remains current.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param source - Stable signal source.
 * @param sourceEventKey - Stable provider-event version.
 * @param disposition - Effective ticket or log disposition.
 */
export function markSignalEffectiveDispositionIfApproved(
  db: Db,
  tenantId: string,
  source: string,
  sourceEventKey: string,
  disposition: 'ticket' | 'log',
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(signalDispositions)
      .set({ effectiveDisposition: disposition, updatedAt: sql`now()` })
      .where(
        and(
          eq(signalDispositions.source, source),
          eq(signalDispositions.sourceEventKey, sourceEventKey),
          eq(signalDispositions.classificationMode, 'enforce'),
          eq(signalDispositions.corpusVersion, SIGNAL_DISPOSITION_CORPUS_VERSION),
          eq(signalDispositions.contractVersion, SEMANTIC_DISPOSITION_CONTRACT_VERSION),
          sql`exists (
            select 1 from ${tenantSignalPolicies} policy
            where policy.tenant_id = ${tenantId}
              and policy.classification_mode = 'enforce'
              and policy.approved_corpus_version = ${signalDispositions.corpusVersion}
              and policy.approved_contract_version = ${signalDispositions.contractVersion}
              and policy.approved_runtime_fingerprint = ${signalDispositions.runtimeFingerprint}
          )`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  });
}
