import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Executor, Tx } from './rls';
import { jobs, surfaceInboundEvents } from './schema';

export interface SurfaceMessageIdentity {
  tenantId: string;
  surface: string;
  channel: string;
  externalMessageId: string;
}

export interface SurfaceMessageDispositionInput extends SurfaceMessageIdentity {
  disposition: string;
  eventAt: Date;
  eventVersion?: string;
}

export type SurfaceMessageDispositionResult =
  { status: 'applied'; updatedCount: number } | { status: 'stale'; updatedCount: 0 };

export type SurfaceInboundRoutingFenceResult<T> =
  { status: 'executed'; value: T } | { status: 'superseded' };

const SUPERSEDED_SIGNAL_WRITE_SQLSTATE = 'P2871';

function surfaceMessageScope(input: SurfaceMessageIdentity) {
  return and(
    eq(surfaceInboundEvents.tenantId, input.tenantId),
    eq(surfaceInboundEvents.surface, input.surface),
    eq(surfaceInboundEvents.channel, input.channel),
    eq(surfaceInboundEvents.externalMessageId, input.externalMessageId),
  );
}

const storedEventVersion = sql<number | null>`coalesce(
  ${surfaceInboundEvents.terminalDispositionEventVersion},
  (extract(epoch from ${surfaceInboundEvents.terminalDispositionEventAt}) * 1000000)::bigint + 999
)`;

function inputEventVersion(input: { eventAt: Date; eventVersion?: string }): number {
  let version: bigint;
  if (input.eventVersion) {
    try {
      version = BigInt(input.eventVersion);
    } catch {
      throw new Error('surface message event version is invalid');
    }
  } else {
    version = BigInt(input.eventAt.getTime()) * 1000n + 999n;
  }
  if (version < 0n || version > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('surface message event version is outside the supported range');
  return Number(version);
}

function classifyJobEventVersion(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as { eventAt?: unknown; eventVersion?: unknown };
  if (typeof candidate.eventAt !== 'string') return null;
  const eventAt = new Date(candidate.eventAt);
  if (!Number.isFinite(eventAt.getTime())) return null;
  try {
    return inputEventVersion({
      eventAt,
      eventVersion: typeof candidate.eventVersion === 'string' ? candidate.eventVersion : undefined,
    });
  } catch {
    return null;
  }
}

function isSupersededSignalWrite(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if (
      'code' in current &&
      (current as { code?: unknown }).code === SUPERSEDED_SIGNAL_WRITE_SQLSTATE
    )
      return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : null;
  }
  return false;
}

async function lockSurfaceMessageTx(tx: Tx, input: SurfaceMessageIdentity): Promise<void> {
  const key = `surface-inbound:${input.tenantId}:${input.surface}:${input.channel}:${input.externalMessageId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function latestSurfaceMessageDecisionTx(tx: Tx, input: SurfaceMessageIdentity) {
  const rows = await tx
    .select({
      disposition: surfaceInboundEvents.terminalDisposition,
      eventAt: surfaceInboundEvents.terminalDispositionEventAt,
      eventVersion: surfaceInboundEvents.terminalDispositionEventVersion,
    })
    .from(surfaceInboundEvents)
    .where(surfaceMessageScope(input))
    .orderBy(
      sql`${storedEventVersion} desc nulls last`,
      sql`${surfaceInboundEvents.terminalDisposition} is not null desc`,
      desc(surfaceInboundEvents.terminalDispositionAt),
    )
    .limit(1);
  return rows[0] ?? { disposition: null, eventAt: null, eventVersion: null };
}

function decisionIsNewer(
  decision: { disposition: string | null; eventAt: Date | null; eventVersion: number | null },
  input: { eventAt: Date; eventVersion?: string },
): boolean {
  const currentVersion =
    decision.eventVersion === null
      ? decision.eventAt
        ? BigInt(decision.eventAt.getTime()) * 1000n + 999n
        : null
      : BigInt(decision.eventVersion);
  if (currentVersion === null) return decision.disposition !== null;
  const candidateVersion = BigInt(inputEventVersion(input));
  return currentVersion > candidateVersion;
}

function decisionIsCurrentOrNewer(
  decision: { disposition: string | null; eventAt: Date | null; eventVersion: number | null },
  input: { eventAt: Date; eventVersion?: string },
): boolean {
  const currentVersion =
    decision.eventVersion === null
      ? decision.eventAt
        ? BigInt(decision.eventAt.getTime()) * 1000n + 999n
        : null
      : BigInt(decision.eventVersion);
  if (currentVersion === null) return decision.disposition !== null;
  return currentVersion >= BigInt(inputEventVersion(input));
}

/**
 * Returns the latest stable-message decision on an existing admission transaction.
 *
 * @param tx - Existing system transaction holding the stable-message lock.
 * @param input - Stable tenant and surface message identity.
 */
export async function getSurfaceMessageDecisionTx(
  tx: Tx,
  input: SurfaceMessageIdentity,
): Promise<{ disposition: string | null; eventAt: Date | null; eventVersion: number | null }> {
  return latestSurfaceMessageDecisionTx(tx, input);
}

/**
 * Reports whether a durable classify job still precedes an edit for one stable surface message.
 *
 * @param exec - System database connection or admission transaction used for the operation.
 * @param input - Stable message identity and optional receipt to exclude from the predecessor search.
 */
export async function hasPendingSurfaceMessageClassification(
  exec: Executor,
  input: SurfaceMessageIdentity & { excludeIntakeId?: string },
): Promise<boolean> {
  const rows = await exec
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(
      surfaceInboundEvents,
      and(
        eq(surfaceInboundEvents.tenantId, jobs.tenantId),
        sql`coalesce(
          ${jobs.idempotencyKey},
          nullif(${jobs.payload}->>'intakeId', '')
        ) = ${surfaceInboundEvents.id}::text`,
      ),
    )
    .where(
      and(
        eq(surfaceInboundEvents.tenantId, input.tenantId),
        eq(surfaceInboundEvents.surface, input.surface),
        sql`coalesce(
          ${surfaceInboundEvents.channel},
          nullif(${jobs.payload}->>'channel', '')
        ) = ${input.channel}`,
        sql`coalesce(
          ${surfaceInboundEvents.externalMessageId},
          nullif(${jobs.payload}->>'externalId', '')
        ) = ${input.externalMessageId}`,
        eq(jobs.tenantId, input.tenantId),
        eq(jobs.type, 'classify'),
        inArray(jobs.status, ['queued', 'processing']),
        input.excludeIntakeId ? ne(surfaceInboundEvents.id, input.excludeIntakeId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Serializes one operation against classification and suppression for a stable surface message.
 *
 * @param db - System database connection used for the operation.
 * @param input - Stable tenant and surface message identity.
 * @param fn - Operation executed while the transaction-scoped message lock is held.
 */
export async function withSurfaceInboundMessageLock<T>(
  db: Db,
  input: SurfaceMessageIdentity,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockSurfaceMessageTx(tx, input);
    return fn(tx);
  });
}

/**
 * Validates and backfills a durable receipt's stable surface identity while its row is locked.
 *
 * @param tx - System transaction used to lock and repair the durable receipt row.
 * @param input - Candidate identity and durable receipt that must describe the same message.
 */
export async function repairSurfaceInboundIdentityTx(
  tx: Tx,
  input: SurfaceMessageIdentity & { intakeId: string },
): Promise<void> {
  const receipts = await tx
    .select({
      surface: surfaceInboundEvents.surface,
      channel: surfaceInboundEvents.channel,
      externalMessageId: surfaceInboundEvents.externalMessageId,
    })
    .from(surfaceInboundEvents)
    .where(
      and(
        eq(surfaceInboundEvents.id, input.intakeId),
        eq(surfaceInboundEvents.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for('update');
  const receipt = receipts[0];
  if (!receipt) throw new Error('classify receipt not found');
  if (receipt.surface !== input.surface)
    throw new Error('classify receipt surface does not match its candidate');
  if (receipt.channel && receipt.channel !== input.channel)
    throw new Error('classify receipt channel does not match its candidate');
  if (receipt.externalMessageId && receipt.externalMessageId !== input.externalMessageId)
    throw new Error('classify receipt message does not match its candidate');
  if (receipt.channel && receipt.externalMessageId) return;
  await tx
    .update(surfaceInboundEvents)
    .set({
      channel: input.channel,
      externalMessageId: input.externalMessageId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(surfaceInboundEvents.id, input.intakeId),
        eq(surfaceInboundEvents.tenantId, input.tenantId),
      ),
    );
}

/**
 * Records a terminal adapter decision when it is not older than the current message decision.
 *
 * @param tx - Existing system transaction holding the stable-message lock.
 * @param input - Stable message identity, terminal reason, and provider event time.
 */
export async function setSurfaceMessageTerminalDispositionTx(
  tx: Tx,
  input: SurfaceMessageDispositionInput,
): Promise<SurfaceMessageDispositionResult> {
  const current = await latestSurfaceMessageDecisionTx(tx, input);
  const version = inputEventVersion(input);
  if (decisionIsNewer(current, input)) return { status: 'stale', updatedCount: 0 };
  const rows = await tx
    .update(surfaceInboundEvents)
    .set({
      classificationOutcome: 'superseded',
      classificationUpdatedAt: sql`now()`,
      terminalDisposition: input.disposition,
      terminalDispositionAt: sql`now()`,
      terminalDispositionEventAt: input.eventAt,
      terminalDispositionEventVersion: version,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        surfaceMessageScope(input),
        sql`(${storedEventVersion} is null or ${storedEventVersion} <= ${version})`,
      ),
    )
    .returning({ id: surfaceInboundEvents.id });
  return { status: 'applied', updatedCount: rows.length };
}

/**
 * Completes classify jobs that a current terminal surface decision has made obsolete.
 *
 * @param tx - System transaction holding the stable-message lock.
 * @param input - Stable message identity and terminal provider-event ordering value.
 */
export async function cancelSurfaceMessageClassificationsTx(
  tx: Tx,
  input: SurfaceMessageIdentity & { eventAt: Date; eventVersion?: string },
): Promise<number> {
  const terminalVersion = inputEventVersion(input);
  const pending = await tx
    .select({ id: jobs.id, payload: jobs.payload })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, input.tenantId),
        eq(jobs.type, 'classify'),
        inArray(jobs.status, ['queued', 'processing']),
        sql`${jobs.payload}->>'channel' = ${input.channel}`,
        sql`${jobs.payload}->>'externalId' = ${input.externalMessageId}`,
      ),
    );
  const supersededIds = pending
    .filter((row) => {
      const version = classifyJobEventVersion(row.payload);
      return version !== null && version <= terminalVersion;
    })
    .map((row) => row.id);
  if (supersededIds.length === 0) return 0;
  const cancelled = await tx
    .update(jobs)
    .set({ status: 'done', lastError: null, updatedAt: sql`now()` })
    .where(and(inArray(jobs.id, supersededIds), inArray(jobs.status, ['queued', 'processing'])))
    .returning({ id: jobs.id });
  return cancelled.length;
}

/**
 * Reports whether a newer or terminal adapter decision already supersedes one intake event.
 *
 * @param db - System database connection used for the operation.
 * @param tenantId - Tenant that owns the receipt.
 * @param intakeId - Durable inbound receipt identifier.
 * @param eventAt - Provider event time of the candidate being classified.
 * @param eventVersion - Exact provider ordering value when finer than JavaScript Date.
 */
export async function isSurfaceInboundSuperseded(
  db: Db,
  tenantId: string,
  intakeId: string,
  eventAt: Date,
  eventVersion?: string,
): Promise<boolean> {
  const receipt = await db
    .select({
      surface: surfaceInboundEvents.surface,
      channel: surfaceInboundEvents.channel,
      externalMessageId: surfaceInboundEvents.externalMessageId,
    })
    .from(surfaceInboundEvents)
    .where(and(eq(surfaceInboundEvents.id, intakeId), eq(surfaceInboundEvents.tenantId, tenantId)))
    .limit(1);
  const row = receipt[0];
  if (!row?.channel || !row.externalMessageId) return false;
  const identity: SurfaceMessageIdentity = {
    tenantId,
    surface: row.surface,
    channel: row.channel,
    externalMessageId: row.externalMessageId,
  };
  const decision = await db.transaction((tx) => latestSurfaceMessageDecisionTx(tx, identity));
  return decisionIsCurrentOrNewer(decision, { eventAt, eventVersion });
}

/**
 * Fences incident routing before and after its callback; the signal trigger protects the callback gap.
 *
 * @param db - Dedicated system coordination connection used for the operation.
 * @param input - Tenant, durable receipt, and provider event time for the classification.
 * @param fn - Incident-routing work whose signal writes are guarded by the database trigger.
 */
export async function withSurfaceInboundRoutingFence<T>(
  db: Db,
  input: SurfaceMessageIdentity & { intakeId: string; eventAt: Date; eventVersion?: string },
  fn: () => Promise<T>,
): Promise<SurfaceInboundRoutingFenceResult<T>> {
  await db.transaction((tx) => repairSurfaceInboundIdentityTx(tx, input));
  const identity: SurfaceMessageIdentity = {
    tenantId: input.tenantId,
    surface: input.surface,
    channel: input.channel,
    externalMessageId: input.externalMessageId,
  };
  const superseded = await db.transaction(async (tx) => {
    await lockSurfaceMessageTx(tx, identity);
    const decision = await latestSurfaceMessageDecisionTx(tx, identity);
    return decisionIsCurrentOrNewer(decision, input);
  });
  if (superseded) return { status: 'superseded' };

  let value: T;
  try {
    value = await fn();
  } catch (error) {
    if (isSupersededSignalWrite(error)) return { status: 'superseded' };
    throw error;
  }
  await db.transaction(async (tx) => {
    await lockSurfaceMessageTx(tx, identity);
    const decision = await latestSurfaceMessageDecisionTx(tx, identity);
    if (
      decisionIsNewer(decision, input) ||
      (decision.disposition !== null && decisionIsCurrentOrNewer(decision, input))
    )
      return;
    await tx
      .update(surfaceInboundEvents)
      .set({
        terminalDisposition: null,
        terminalDispositionAt: null,
        terminalDispositionEventAt: input.eventAt,
        terminalDispositionEventVersion: inputEventVersion(input),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          surfaceMessageScope(identity),
          sql`(${storedEventVersion} is null or ${storedEventVersion} <= ${inputEventVersion(input)})`,
        ),
      );
  });
  return { status: 'executed', value };
}
