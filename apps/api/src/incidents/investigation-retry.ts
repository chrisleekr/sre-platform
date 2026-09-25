import {
  activeResponderTx,
  attentionColumns,
  incidentMessages,
  incidents,
  lockResponseGroupWorkTx,
  summaryColumns,
  withTenant,
} from '@sre/db';
import { INVESTIGATION_RETRY_ORIGIN_PREFIX } from '@sre/contracts';
import type { HubMessage } from '@sre/hub';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { TenantAuthVariables } from '../auth';
import { UUID_RE, type IncidentRouteDeps } from './support';

/** The human line that asks the engine to continue; the resume job consumes it like a reply. */
export const INVESTIGATION_RETRY_MESSAGE = 'Retry the investigation.';

const RETRYABLE_REASONS = new Set(['investigation_degraded', 'investigation_failed']);

type RetryResult =
  | { outcome: 'forbidden' | 'not_found' | 'stale' | 'not_retryable' | 'automation_pending' }
  | { outcome: 'queued'; message: HubMessage; jobId: string | null; replayed: boolean };

/**
 * Registers the responder control that re-runs a failed or degraded investigation. It is a human
 * continuation, not a new ingress: the request appends one attributed hub message and enqueues the
 * existing resume job for it in the same tenant transaction.
 *
 * @param app - Incident router the route is added to.
 * @param deps - Incident route collaborators; the hub and resume queue are required.
 */
export function registerInvestigationRetryRoute(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  app.post('/:id/investigation/retry', async (c) => {
    const hub = deps.hub;
    const queue = deps.resumeQueue;
    if (!hub || !queue) return c.json({ error: 'investigation retry not configured' }, 503);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    const body = await c.req
      .json<{ requestId?: unknown; expectedVersion?: unknown }>()
      .catch(() => null);
    if (
      !body ||
      typeof body.requestId !== 'string' ||
      !UUID_RE.test(body.requestId) ||
      !Number.isInteger(body.expectedVersion) ||
      Number(body.expectedVersion) < 0
    )
      return c.json({ error: 'A request identity and current version are required.' }, 400);
    const originMessageId = `${INVESTIGATION_RETRY_ORIGIN_PREFIX}${id}:${body.requestId}`;
    const expectedVersion = Number(body.expectedVersion);

    const result = await withTenant(deps.db, tenantId, async (tx): Promise<RetryResult> => {
      if (!(await activeResponderTx(tx, tenantId, userId))) return { outcome: 'forbidden' };
      // Group work locks before the incident row, matching signal writers and the hub append.
      await lockResponseGroupWorkTx(tx, tenantId, id);
      const [incident] = await tx
        .select({
          status: incidents.status,
          archivedAt: incidents.archivedAt,
          lifecycleVersion: incidents.lifecycleVersion,
          pendingAutomation: summaryColumns.pendingAutomation,
          attentionReason: attentionColumns.attentionReason,
        })
        .from(incidents)
        .where(eq(incidents.id, id))
        .limit(1)
        .for('update');
      if (!incident || incident.archivedAt) return { outcome: 'not_found' };
      // An HTTP retry of an accepted request returns the first result; the guard below would
      // otherwise refuse it because the first request's resume job is now pending.
      const [existing] = await tx
        .select({ id: incidentMessages.id })
        .from(incidentMessages)
        .where(
          and(
            eq(incidentMessages.incidentId, id),
            eq(incidentMessages.originMessageId, originMessageId),
          ),
        )
        .limit(1);
      if (!existing) {
        if (incident.lifecycleVersion !== expectedVersion) return { outcome: 'stale' };
        if (
          !['open', 'mitigated'].includes(incident.status) ||
          !RETRYABLE_REASONS.has(incident.attentionReason ?? '')
        )
          return { outcome: 'not_retryable' };
        if (incident.pendingAutomation) return { outcome: 'automation_pending' };
      }
      const appended = await hub.appendTxOnce(tx, tenantId, id, {
        author: 'human',
        content: INVESTIGATION_RETRY_MESSAGE,
        originSurface: 'dashboard',
        authorUserId: userId ?? null,
        originMessageId,
      });
      const jobId = appended.inserted
        ? (await queue.insertResumeTx(tx, tenantId, id, appended.message.id)).jobId
        : null;
      return { outcome: 'queued', message: appended.message, jobId, replayed: !appended.inserted };
    });

    if (result.outcome === 'forbidden')
      return c.json({ error: 'An active workspace member is required for this change.' }, 403);
    if (result.outcome === 'not_found') return c.json({ error: 'incident not found' }, 404);
    if (result.outcome !== 'queued') return c.json({ error: result.outcome }, 409);
    // Post-commit only: the message and job are durable, so a failed publish is recovered by history
    // replay and the queue reconciler rather than failing a request the client would then repeat.
    await hub.publishAppendedBestEffort(result.message);
    if (result.jobId)
      await queue.publishResume(result.jobId).catch((error) =>
        deps.log?.error('Investigation retry publish failed; durable job remains queued', {
          tenantId,
          incidentId: id,
          jobId: result.jobId,
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
    return c.json({ outcome: 'queued', messageId: result.message.id, replayed: result.replayed });
  });
}
