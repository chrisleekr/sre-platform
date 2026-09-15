import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  activeResponderTx,
  consumeCaptureProposalTx,
  humanMessageFenceMatchesTx,
  jobs,
  lockIncidentWorkTx,
  withTenant,
  type HumanMessage,
} from '@sre/db';
import { RetryableError } from '@sre/queue';
import type { WorkerRuntime } from './runtime';

/** Queue knowledge capture with the authenticated request and receipt in one transaction.
 * @param runtime - Durable queue and conversation dependencies.
 * @param tenantId - Server-selected workspace.
 * @param incidentId - Current case.
 * @param request - Persisted human request, never model-selected identity.
 * @param fence - Latest human message used during interpretation.
 * @param confirmation - Requires current durable capture-only consent for a bare Yes.
 */
export async function requestKnowledgeCapture(
  runtime: WorkerRuntime,
  tenantId: string,
  incidentId: string,
  request: HumanMessage,
  fence: string,
  confirmation = false,
): Promise<void> {
  const { deps } = runtime;
  const queue = deps.runbookQueue;
  const result = await withTenant(deps.appDb, tenantId, async (tx) => {
    await lockIncidentWorkTx(tx, tenantId, [incidentId]);
    if (!(await humanMessageFenceMatchesTx(tx, incidentId, fence)))
      throw new RetryableError(
        'New input arrived before knowledge capture; reinterpret the request.',
      );
    const authorized = await activeResponderTx(tx, tenantId, request.authorUserId);
    const confirmed =
      !confirmation ||
      (authorized &&
        !!queue &&
        (await consumeCaptureProposalTx(tx, incidentId, request.authorUserId!, request.id)));
    let jobId: string | null = null;
    if (authorized && queue && confirmed) {
      const [existing] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            eq(jobs.type, 'runbook.generate'),
            sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
            or(
              sql`${jobs.payload}->>'requestedMessageId' = ${request.id}`,
              inArray(jobs.status, ['queued', 'processing']),
            ),
          ),
        )
        .limit(1);
      if (!existing)
        jobId = await queue.insertJobTx(tx, {
          tenantId,
          type: 'runbook.generate',
          payload: {
            incidentId,
            requestedBy: request.authorUserId,
            requestedMessageId: request.id,
          },
        });
    }
    const { message } = await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
      author: 'system',
      kind: 'reply',
      content: !authorized
        ? 'I could not save a runbook. An active, linked workspace member must request it.'
        : !queue
          ? 'Knowledge capture is not configured. No runbook was saved. Ask the platform administrator to enable it.'
          : !confirmed
            ? 'There is no current capture offer for you to confirm. Nothing was saved. Ask explicitly to save a diagnostic guide if you want one.'
            : 'Runbook capture requested. I will save reusable guidance in this workspace and post the document here. Without a verified fix, it will be a diagnostic guide, not a proven remediation. No repository will be changed.',
      originMessageId: `knowledge-request:${request.id}`,
    });
    return { jobId, message };
  });
  await deps.hub.publishAppendedBestEffort(result.message);
  if (result.jobId) await queue!.publishJob(result.jobId);
}
