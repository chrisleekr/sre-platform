import { DEFAULT_COHORT_WINDOW_MS } from '@sre/alerts';
import { joinAlertCohortTx, type Tx } from '@sre/db';
import type { Queue } from '@sre/queue';

/**
 * Adds a newly opened provider-alert incident to its Slack channel cohort and queues the cohort's
 * relationship analysis, so alerts from one burst can be related. Returns any job to publish.
 * @param tx - Tenant transaction that opened the incident.
 * @param queue - Durable work queue.
 * @param tenantId - Owning tenant.
 * @param channel - Slack channel the alert was posted in.
 * @param signalId - First signal of the new incident.
 */
export async function joinSlackAlertCohortTx(
  tx: Tx,
  queue: Pick<Queue, 'insertCohortAnalysisTx'>,
  tenantId: string,
  channel: string,
  signalId: string,
): Promise<string[]> {
  // Processing time, not event or receipt time: under a classify backlog an earlier-stamped window
  // can close and be analyzed before later members of the same burst are processed. The cost is that
  // a burst processed more than one window apart splits into separate cohorts. No observedAt: the
  // repo stamps it under the scope lock, so concurrent workers cannot open overlapping windows.
  const cohort = await joinAlertCohortTx(tx, tenantId, {
    sourceScopeKey: `slack:${channel}`,
    signalId,
    windowMs: DEFAULT_COHORT_WINDOW_MS,
  });
  if (cohort.state !== 'collecting') return [];
  const { jobId } = await queue.insertCohortAnalysisTx(
    tx,
    tenantId,
    cohort.id,
    new Date(cohort.windowEndsAt.getTime() + 2_000),
  );
  return jobId ? [jobId] : [];
}
