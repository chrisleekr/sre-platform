import { scrubSecrets } from '@sre/agent-tools';
import { RESOLUTION_POLICIES, type ResolutionPolicy } from '@sre/contracts';
import { getIncidentSummary } from '@sre/db';
import type { Hono } from 'hono';
import type { TenantAuthVariables } from '../auth';
import { UUID_RE, type IncidentRouteDeps } from './support';

export function registerResolutionPolicyRoute(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
) {
  app.post('/:id/resolution-policy', async (c) => {
    if (!deps.hub || !deps.declarationQueue)
      return c.json({ error: 'resolution policy not configured' }, 503);
    const id = c.req.param('id');
    const { tenantId, userId } = c.get('tenant');
    if (!UUID_RE.test(id) || !(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'incident not found' }, 404);
    const body = await c.req
      .json<{
        policy?: unknown;
        reason?: unknown;
        requestId?: unknown;
        expectedVersion?: unknown;
      }>()
      .catch(() => null);
    if (
      !body ||
      !RESOLUTION_POLICIES.includes(body.policy as ResolutionPolicy) ||
      typeof body.reason !== 'string' ||
      !body.reason.trim() ||
      body.reason.length > 2000 ||
      typeof body.requestId !== 'string' ||
      !UUID_RE.test(body.requestId) ||
      !Number.isInteger(body.expectedVersion) ||
      Number(body.expectedVersion) < 0
    )
      return c.json(
        { error: 'A policy, reason, request identity and current version are required.' },
        400,
      );
    const result = await deps.hub.changeResolutionPolicy(tenantId, id, {
      policy: body.policy as ResolutionPolicy,
      reason: scrubSecrets(body.reason.trim()),
      requestId: body.requestId,
      expectedVersion: Number(body.expectedVersion),
      authorUserId: userId ?? null,
      enqueueRecoveryTx: async (tx, recovery) =>
        (
          await deps.declarationQueue!.insertRecoveryTx(
            tx,
            tenantId,
            recovery.rootIncidentId,
            recovery.lifecycleVersion,
            recovery.signalFence,
          )
        ).jobId,
    });
    if (result.outcome === 'forbidden')
      return c.json({ error: 'An active workspace member is required.' }, 403);
    if (result.outcome === 'not_found') return c.json({ error: 'incident not found' }, 404);
    if (!['applied', 'noop'].includes(result.outcome))
      return c.json({ error: result.outcome }, 409);
    if (result.message) await deps.hub.publishAppendedBestEffort(result.message);
    if (result.recoveryJobId)
      await deps.declarationQueue.publishJob(result.recoveryJobId).catch(() => undefined);
    return c.json({ outcome: result.outcome });
  });
}
