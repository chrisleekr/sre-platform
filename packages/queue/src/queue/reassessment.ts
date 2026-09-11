import type {
  InvestigationSignalChange,
  InvestigationTrigger,
  InvestigationTriggerReason,
} from '@sre/contracts';
import { incidentSignalInvestigationTriggerReason, incidentSignals, jobs, type Tx } from '@sre/db';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Parses the causal signal versions retained by a coalesced reassessment job.
 *
 * @param payload - Untrusted durable queue payload.
 */
export function reassessmentSignalChanges(payload: unknown): InvestigationSignalChange[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const changes = record.signalChanges;
  if (!Array.isArray(changes)) {
    const trigger =
      record.investigationTrigger && typeof record.investigationTrigger === 'object'
        ? (record.investigationTrigger as Record<string, unknown>)
        : null;
    return typeof record.signalId === 'string' && Number.isInteger(record.signalVersion)
      ? [
          {
            signalId: record.signalId,
            signalVersion: record.signalVersion as number,
            triggerReason:
              typeof trigger?.reason === 'string'
                ? (trigger.reason as InvestigationTriggerReason)
                : 'material_change',
          },
        ]
      : [];
  }
  return changes.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const change = value as Record<string, unknown>;
    return typeof change.signalId === 'string' &&
      Number.isInteger(change.signalVersion) &&
      typeof change.triggerReason === 'string'
      ? [
          {
            signalId: change.signalId,
            signalVersion: change.signalVersion as number,
            triggerReason: change.triggerReason as InvestigationTriggerReason,
          },
        ]
      : [];
  });
}

/**
 * Retains the newest causal version of every signal in deterministic order.
 *
 * @param current - Signal changes already retained by the queued job.
 * @param incoming - New signal change being coalesced.
 */
export function mergeReassessmentSignalChanges(
  current: InvestigationSignalChange[],
  incoming: InvestigationSignalChange,
): InvestigationSignalChange[] {
  const merged = new Map(current.map((change) => [change.signalId, change]));
  const previous = merged.get(incoming.signalId);
  if (!previous || incoming.signalVersion >= previous.signalVersion)
    merged.set(incoming.signalId, incoming);
  return [...merged.values()].sort((left, right) => left.signalId.localeCompare(right.signalId));
}

/**
 * Collapses several causal transitions to the strongest investigation mode.
 *
 * @param changes - Causal signal changes retained by the job.
 */
export function reassessmentTriggerReason(
  changes: InvestigationSignalChange[],
): InvestigationTriggerReason {
  if (changes.some((change) => change.triggerReason === 'new_episode')) return 'new_episode';
  if (changes.some((change) => change.triggerReason === 'material_change'))
    return 'material_change';
  return 'state_transition';
}

/**
 * Coalesces every outstanding signal version into one durable reassessment job.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param input - Incident, signal, trigger, and stream used to create the job.
 */
export async function insertReassessmentJobTx(
  tx: Tx,
  input: {
    tenantId: string;
    incidentId: string;
    signalId: string;
    signalVersion: number;
    triggerReason: InvestigationTriggerReason;
    stream: string;
  },
): Promise<{ jobId: string | null }> {
  const signalRows = await tx
    .select({
      id: incidentSignals.id,
      version: incidentSignals.version,
      state: incidentSignals.state,
      lastEventType: incidentSignals.lastEventType,
      monitorKey: incidentSignals.monitorKey,
      lastInvestigatedVersion: incidentSignals.lastInvestigatedVersion,
    })
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.tenantId, input.tenantId),
        eq(incidentSignals.incidentId, input.incidentId),
      ),
    );
  const requestedSignal = signalRows.find(
    (signal) => signal.id === input.signalId && signal.version === input.signalVersion,
  );
  const change: InvestigationSignalChange = {
    signalId: input.signalId,
    signalVersion: input.signalVersion,
    triggerReason: requestedSignal
      ? incidentSignalInvestigationTriggerReason(signalRows, requestedSignal)
      : input.triggerReason,
  };
  const outstandingChanges = signalRows
    .filter((signal) => signal.lastInvestigatedVersion !== signal.version)
    .map((signal) => ({
      signalId: signal.id,
      signalVersion: signal.version,
      triggerReason: incidentSignalInvestigationTriggerReason(signalRows, signal),
    }));
  const mergeChanges = (
    current: InvestigationSignalChange[],
    incoming: InvestigationSignalChange[],
  ) => incoming.reduce((merged, next) => mergeReassessmentSignalChanges(merged, next), current);
  const initialChanges = mergeChanges(outstandingChanges, [change]);
  const makePayload = (signalChanges: InvestigationSignalChange[]) => ({
    incidentId: input.incidentId,
    signalChanges,
    investigationTrigger: {
      reason: reassessmentTriggerReason(signalChanges),
      automatic: true,
      monitorKey: null,
    } satisfies InvestigationTrigger,
  });
  for (let round = 0; round < 2; round++) {
    const payload = makePayload(initialChanges);
    const inserted = await tx
      .insert(jobs)
      .values({
        tenantId: input.tenantId,
        type: 'signal.reassess',
        payload,
        status: 'queued',
        stream: input.stream,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (inserted[0]) return { jobId: inserted[0].id };
    const pending = await tx
      .select({ id: jobs.id, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, input.tenantId),
          eq(jobs.type, 'signal.reassess'),
          eq(jobs.status, 'queued'),
          sql`payload->>'incidentId' = ${input.incidentId}`,
        ),
      )
      .limit(1)
      .for('update');
    if (!pending[0]) continue;
    const mergedPayload = makePayload(
      mergeChanges(reassessmentSignalChanges(pending[0].payload), initialChanges),
    );
    const refreshed = await tx
      .update(jobs)
      .set({ payload: mergedPayload, updatedAt: sql`now()` })
      .where(and(eq(jobs.id, pending[0].id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id });
    if (refreshed[0]) return { jobId: null };
  }
  throw new Error('signal reassessment coalesce raced a job claim twice');
}
