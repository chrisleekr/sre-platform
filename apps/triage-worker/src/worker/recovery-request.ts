import {
  activeResponderTx,
  humanMessageFenceMatchesTx,
  listResponseGroupSignalsTx,
  withTenant,
  type HumanMessage,
} from '@sre/db';
import { RetryableError, type Job } from '@sre/queue';
import { RECOVERY_NOT_QUEUED, startReportedRecoveryTx } from '../recovery-start';
import type { WorkerRuntime } from './runtime';

const CHECK_INSTEAD = 'Running a check instead; nothing will be resolved.';
const FORBIDDEN =
  'I could not start recovery verification. An active, linked workspace member is required; the case is unchanged.';

type Outcome = 'handled' | 'investigate' | 'forbidden';

// The posted line is the only durable record of a request's outcome, so a redelivery reads the
// outcome back from it: FORBIDDEN is forbidden, a line ending in CHECK_INSTEAD investigates, and
// anything else was handled. Changing either constant's wording changes how redeliveries route.
const outcomeOf = (content: string): Outcome =>
  content === FORBIDDEN ? 'forbidden' : content.endsWith(CHECK_INSTEAD) ? 'investigate' : 'handled';

/** Start recovery verification for a responder request and post the outcome.
 * Returns `investigate` when verification cannot start, so a check still answers the request, and
 * `forbidden` when the author may not act, so earlier pending questions are kept.
 * @param runtime - Worker dependencies.
 * @param job - Tenant-scoped resume job.
 * @param incidentId - Server-selected current case.
 * @param request - Authenticated responder request.
 * @param fence - Latest interpreted human message.
 */
export async function requestRecoveryVerification(
  runtime: WorkerRuntime,
  job: Job,
  incidentId: string,
  request: HumanMessage,
  fence: string,
): Promise<Outcome> {
  const { deps } = runtime;
  const origin = `recovery-request:${request.id}`;
  // A redelivered request already resolved its signals, so a second pass would find nothing to start.
  const committed = await deps.hub.appendedByOrigin(job.tenantId, incidentId, origin);
  if (committed) {
    await deps.hub.publishAppended(committed);
    return outcomeOf(committed.content);
  }
  const started = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const append = (content: string) =>
      deps.hub.appendTxOnce(tx, job.tenantId, incidentId, {
        author: 'system',
        kind: 'status',
        content,
        originMessageId: origin,
      });
    // Same authority as a verbal lifecycle change: only an active, linked workspace member.
    if (!(await activeResponderTx(tx, job.tenantId, request.authorUserId))) {
      const { message } = await append(FORBIDDEN);
      return { message, jobId: null };
    }
    const state = await startReportedRecoveryTx(tx, deps.queue, job.tenantId, incidentId);
    // Checked after the signal locks are held; throwing rolls back the resolution.
    if (!(await humanMessageFenceMatchesTx(tx, incidentId, fence)))
      throw new RetryableError(
        'New input arrived before recovery verification; reinterpret the request.',
      );
    // Only reached when nothing else explains it: an open case whose group has no alerts at all.
    const unsignalled = async () =>
      (await listResponseGroupSignalsTx(tx, job.tenantId, incidentId)).length === 0;
    const content = state.queued
      ? 'Verifying recovery. The incident resolves only if verification confirms it.'
      : state.prepared
        ? // The responder asked for a recheck, so a refused verification still runs one.
          `${RECOVERY_NOT_QUEUED} ${CHECK_INSTEAD}`
        : state.resolved.length > 0
          ? `Reported alerts are resolved. Verification waits for the other incidents in this response group. ${CHECK_INSTEAD}`
          : state.durable
            ? `Recovery verification cannot start: provider-verified alerts stay active until the provider clears them. ${CHECK_INSTEAD}`
            : state.active > 0
              ? `Recovery verification cannot start: an active alert on this incident has no recorded recovery report. ${CHECK_INSTEAD}`
              : state.closed
                ? `Recovery verification cannot start: this case is no longer open. ${CHECK_INSTEAD}`
                : (await unsignalled())
                  ? `Recovery verification cannot start: this case has no alerts to verify. ${CHECK_INSTEAD}`
                  : `Recovery verification cannot start: another incident in its response group still has an active alert. ${CHECK_INSTEAD}`;
    const { message } = await append(content);
    return { message, jobId: state.jobId };
  });
  await deps.hub.publishAppended(started.message);
  if (started.jobId) await deps.queue.publishJob(started.jobId);
  return outcomeOf(started.message.content);
}
