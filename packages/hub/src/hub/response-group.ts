import {
  ACTIVE_STATUSES,
  approvals,
  connectorConfigs,
  incidents,
  listResponseGroupIncidentIdsTx,
  listResponseGroupSignalsTx,
  lockResponseGroupWorkTx,
  prepareResponseGroupRecoveryTx,
  transitionIncidentTx,
  serializeSignalFence,
  resolveResponseRootTx,
  type Tx,
} from '@sre/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { HubMessage } from './contracts';
import type { HubStore } from './store';

/** Resolves a root and every active causal symptom while their group locks are held. */
export async function appendResolvedResponseGroupTx(
  store: HubStore,
  tx: Tx,
  tenantId: string,
  rootIncidentId: string,
  responseGroupIds: string[],
  expectedRootVersion: number,
  rootContent: string,
  transitionKey: string,
  basis: NonNullable<typeof incidents.$inferSelect.resolutionBasis> = 'verified_recovery',
): Promise<HubMessage[]> {
  const messages: HubMessage[] = [];
  const rootTransition = await transitionIncidentTx(tx, rootIncidentId, 'resolved', {
    expectedVersion: expectedRootVersion,
  });
  if (rootTransition.outcome !== 'applied') return messages;
  messages.push(
    await store.appendTx(tx, tenantId, rootIncidentId, {
      author: 'system',
      kind: 'lifecycle',
      content: rootContent,
      originSurface: 'automation',
      lifecycleFrom: rootTransition.from,
      lifecycleTo: rootTransition.to,
      lifecycleVersion: rootTransition.version!,
      transitionKey,
    }),
  );
  for (const childIncidentId of responseGroupIds.filter((id) => id !== rootIncidentId)) {
    const childRows = await tx
      .select({ status: incidents.status })
      .from(incidents)
      .where(eq(incidents.id, childIncidentId))
      .limit(1);
    const child = childRows[0];
    if (!child || !ACTIVE_STATUSES.includes(child.status as (typeof ACTIVE_STATUSES)[number]))
      continue;
    const childTransition = await transitionIncidentTx(tx, childIncidentId, 'resolved');
    if (childTransition.outcome !== 'applied') continue;
    messages.push(
      await store.appendTx(tx, tenantId, childIncidentId, {
        author: 'system',
        kind: 'lifecycle',
        content:
          basis === 'provider_clear'
            ? 'Incident resolved from authoritative provider signals. Service health was not independently verified.'
            : 'Incident resolved: The causal response group recovered.',
        originSurface: 'automation',
        lifecycleFrom: childTransition.from,
        lifecycleTo: childTransition.to,
        lifecycleVersion: childTransition.version!,
        transitionKey: `${transitionKey}:${childIncidentId}`,
      }),
    );
  }
  if (messages.length)
    await tx
      .update(incidents)
      .set({
        resolutionBasis: basis,
        // A provider clear supersedes any earlier recovery narrative, such as the blocked-on-approval
        // summary, which would otherwise tell the operator to act on a resolved incident.
        ...(basis === 'provider_clear'
          ? {
              recoveryState: null,
              recoverySummary: null,
              recoveryEvidenceIds: null,
              recoveryUnknowns: null,
              recoveryQuestions: null,
              recoveryQuestionsUpdatedAt: null,
              recoveryNextStep: null,
              recoveryUpdatedAt: null,
              recoveryNextCheckAt: null,
              recoveryScheduleReason: null,
            }
          : {}),
      })
      .where(
        inArray(
          incidents.id,
          messages.map((message) => message.incidentId),
        ),
      );
  return messages;
}

/** Durable recovery hand-off used when the approval transaction cannot evaluate provider clearance. */
export type EnqueueRecoveryTx = (
  tx: Tx,
  candidate: { rootIncidentId: string; lifecycleVersion: number; signalFence: string },
) => Promise<string | null>;

/**
 * Completes an eligible response group after its final pending approval is decided.
 *
 * `resolveResponseRootTx` takes the tenant causal-graph lock, which every causal edge writer also
 * takes, so the root it returns stays the root for the rest of this transaction.
 */
export async function completeVerifiedRecoveryAfterApprovalTx(
  store: HubStore,
  tx: Tx,
  tenantId: string,
  incidentId: string,
  approvalId: string,
  enqueueRecoveryTx?: EnqueueRecoveryTx,
): Promise<HubMessage[]> {
  let provider: Awaited<ReturnType<typeof resolveProviderClearTx>>;
  try {
    provider = await resolveProviderClearTx(
      store,
      tx,
      tenantId,
      await resolveResponseRootTx(tx, tenantId, incidentId),
      `approval-provider-recovery:${incidentId}:${approvalId}`,
    );
  } catch (error) {
    if (!(error instanceof ProviderClearLockContendedError) || !enqueueRecoveryTx) throw error;
    // The decision must commit. A recovery job re-evaluates provider clearance in a fresh
    // transaction that holds no incident locks.
    const candidate = await prepareResponseGroupRecoveryTx(tx, tenantId, incidentId);
    if (candidate) await enqueueRecoveryTx(tx, candidate);
    return [];
  }
  if (provider.handled) return provider.messages;
  const { rootIncidentId, incidentIds } = await lockResponseGroupWorkTx(tx, tenantId, incidentId);
  const locked = await tx
    .select({
      id: incidents.id,
      status: incidents.status,
      lifecycleVersion: incidents.lifecycleVersion,
      recoveryState: incidents.recoveryState,
      archivedAt: incidents.archivedAt,
    })
    .from(incidents)
    .where(inArray(incidents.id, incidentIds))
    .orderBy(incidents.id)
    .for('update');
  const root = locked.find((row) => row.id === rootIncidentId);
  if (
    !root ||
    root.archivedAt ||
    !ACTIVE_STATUSES.includes(root.status as (typeof ACTIVE_STATUSES)[number]) ||
    root.recoveryState !== 'verified'
  )
    return [];
  const pending = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(inArray(approvals.incidentId, incidentIds), isNull(approvals.decision)))
    .limit(1);
  if (pending[0]) return [];
  const signals = await listResponseGroupSignalsTx(tx, tenantId, rootIncidentId);
  if (signals.length === 0 || signals.some((signal) => signal.state !== 'resolved')) return [];
  return appendResolvedResponseGroupTx(
    store,
    tx,
    tenantId,
    rootIncidentId,
    incidentIds,
    root.lifecycleVersion,
    'Incident resolved: provider signals are clear and verified recovery was waiting on this approval.',
    `approval-recovery:${rootIncidentId}:${approvalId}`,
  );
}

/** Connector generations are locked by a concurrent write; the caller must evaluate again later. */
export class ProviderClearLockContendedError extends Error {
  constructor() {
    super('provider clear evaluation contended with a connector write');
    this.name = 'ProviderClearLockContendedError';
  }
}

function isLockNotAvailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === '55P03') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function requiresProviderEvidence(row: typeof incidents.$inferSelect): boolean {
  return row.resolutionPolicy === 'provider_clear' && row.purpose !== 'health_check';
}

/**
 * Evaluates provider recovery using the same locked response group as evidence-based recovery.
 *
 * `incidentId` must be the response-group root. Any other id returns `handled: true` with nothing
 * written, as a stale `expected` fence does, and as the verified-recovery path refuses a non-root
 * recovery job. Pass the id `resolveResponseRootTx` or `prepareResponseGroupRecoveryTx` returned.
 *
 * Throws {@link ProviderClearLockContendedError} when a connector write holds the generation rows.
 * The caller's transaction stays usable.
 */
export async function resolveProviderClearTx(
  store: HubStore,
  tx: Tx,
  tenantId: string,
  incidentId: string,
  transitionKey: string,
  expected?: { lifecycleVersion: number; signalFence: string },
): Promise<{ handled: boolean; messages: HubMessage[] }> {
  const candidateSignals = await listResponseGroupSignalsTx(tx, tenantId, incidentId);
  const connectorIds = [
    ...new Set(
      candidateSignals.flatMap((signal) => (signal.dataSourceId ? [signal.dataSourceId] : [])),
    ),
  ];
  // Unlocked pre-check: only an all-provider-clear group reads connector generations, so a
  // verified-recovery group never contends with connector writes. The locked re-check below is
  // authoritative.
  const preview = await tx
    .select()
    .from(incidents)
    .where(inArray(incidents.id, await listResponseGroupIncidentIdsTx(tx, tenantId, incidentId)));
  const previewActive = preview.filter((row) =>
    ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number]),
  );
  const generationsLocked =
    previewActive.length > 0 && previewActive.every(requiresProviderEvidence);
  let generations: (typeof connectorConfigs.$inferSelect)[] = [];
  if (generationsLocked && connectorIds.length) {
    // Approval callers may already hold incident locks. NOWAIT avoids reversing native intake
    // locks. The savepoint keeps a lock_not_available failure from aborting the caller's
    // transaction.
    try {
      generations = await tx.transaction((savepoint) =>
        savepoint
          .select()
          .from(connectorConfigs)
          .where(inArray(connectorConfigs.id, connectorIds))
          .orderBy(connectorConfigs.id)
          .for('share', { noWait: true }),
      );
    } catch (error) {
      if (isLockNotAvailable(error)) throw new ProviderClearLockContendedError();
      throw error;
    }
  }
  const { rootIncidentId, incidentIds } = await lockResponseGroupWorkTx(tx, tenantId, incidentId);
  const rows = await tx
    .select()
    .from(incidents)
    .where(inArray(incidents.id, incidentIds))
    .orderBy(incidents.id)
    .for('update');
  const root = rows.find((row) => row.id === rootIncidentId);
  const active = rows.filter((row) =>
    ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number]),
  );
  if (
    !root ||
    root.archivedAt ||
    !ACTIVE_STATUSES.includes(root.status as (typeof ACTIVE_STATUSES)[number]) ||
    rootIncidentId !== incidentId
  )
    return { handled: true, messages: [] };
  if (!active.every(requiresProviderEvidence)) return { handled: false, messages: [] };
  // The group became provider-clear after the unlocked pre-check, so its generations were never
  // locked and cannot be taken now without reversing the lock order.
  if (!generationsLocked) throw new ProviderClearLockContendedError();
  const signals = await listResponseGroupSignalsTx(tx, tenantId, rootIncidentId);
  if (
    expected &&
    (root.lifecycleVersion !== expected.lifecycleVersion ||
      serializeSignalFence(signals) !== expected.signalFence)
  )
    return { handled: true, messages: [] };
  if (signals.some((signal) => signal.state !== 'resolved')) return { handled: true, messages: [] };
  const pending = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(inArray(approvals.incidentId, incidentIds), isNull(approvals.decision)))
    .limit(1);
  const proven =
    signals.length > 0 &&
    signals.every(
      (signal) =>
        signal.clearProvenance === 'provider' &&
        Boolean(
          signal.dataSourceId &&
          signal.providerFingerprint &&
          signal.startsAt &&
          signal.signalSource?.kind === 'monitor' &&
          signal.signalSource.dataSourceId === signal.dataSourceId &&
          generations.some(
            (config) =>
              config.id === signal.dataSourceId &&
              config.enabled &&
              !config.deletedAt &&
              config.lifecycleVersion === signal.providerClearGeneration,
          ),
        ),
    ) &&
    active.every((row) => signals.some((signal) => signal.incidentId === row.id));
  if (pending[0] || !proven) {
    const summary = pending[0]
      ? 'Provider notifications cleared; an approval is still pending.'
      : 'Provider recovery is not established for every signal. Operator corrections, suppressed notifications and legacy clear states do not prove provider recovery.';
    const nextStep = pending[0]
      ? 'Decide the pending action before completing resolution.'
      : 'Obtain an authoritative provider recovery or select verified recovery and check current service health.';
    await tx
      .update(incidents)
      .set({
        recoveryState: 'not_verified',
        recoverySummary: summary,
        recoveryNextStep: nextStep,
        recoveryUpdatedAt: sql`now()`,
        resolutionBasis: null,
      })
      .where(eq(incidents.id, rootIncidentId));
    const { message } = await store.appendTxOnce(tx, tenantId, rootIncidentId, {
      author: 'system',
      kind: 'status',
      content: summary,
      summary,
      originMessageId: `${transitionKey}:blocked`,
    });
    return { handled: true, messages: [message] };
  }
  const messages = await appendResolvedResponseGroupTx(
    store,
    tx,
    tenantId,
    rootIncidentId,
    incidentIds,
    root.lifecycleVersion,
    'Incident resolved from authoritative provider signals. Service health was not independently verified.',
    transitionKey,
    'provider_clear',
  );
  return { handled: true, messages };
}
