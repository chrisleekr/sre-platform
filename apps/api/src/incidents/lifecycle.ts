import { registerInvestigationRetryRoute } from './investigation-retry';
import { registerResolutionPolicyRoute } from './resolution-policy';
import { scrubSecrets } from '@sre/agent-tools';
import { getIncident, getIncidentSummary } from '@sre/db';
import { Hono } from 'hono';
import { requirePlatformAdmin, type TenantAuthVariables } from '../auth';

import { UUID_RE, isLifecycleStatus, type IncidentRouteDeps } from './support';

export function registerIncidentLifecycleRoutes(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  registerResolutionPolicyRoute(app, deps);
  registerInvestigationRetryRoute(app, deps);
  app.post('/:id/lifecycle', async (c) => {
    if (!deps.hub) return c.json({ error: 'incident lifecycle not configured' }, 503);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    if (!(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'incident not found' }, 404);

    let body: {
      to?: unknown;
      reason?: unknown;
      requestId?: unknown;
      expectedVersion?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid lifecycle request' }, 400);
    }
    if (!isLifecycleStatus(body.to)) return c.json({ error: 'invalid lifecycle status' }, 400);
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0)
      return c.json({ error: 'reason required' }, 400);
    if (body.reason.length > 2_000) return c.json({ error: 'reason too long' }, 400);
    if (typeof body.requestId !== 'string' || !UUID_RE.test(body.requestId))
      return c.json({ error: 'requestId required' }, 400);
    if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0)
      return c.json({ error: 'invalid expectedVersion' }, 400);

    const result = await deps.hub.transitionIncident(tenantId, id, {
      to: body.to,
      reason: scrubSecrets(body.reason.trim()),
      transitionKey: `dashboard:${id}:${body.requestId}`,
      author: 'human',
      originSurface: 'dashboard',
      authorUserId: userId ?? null,
      expectedVersion: body.expectedVersion as number,
    });
    if (result.transition.outcome === 'not_found')
      return c.json({ error: 'incident not found' }, 404);
    if (result.transition.outcome === 'forbidden')
      return c.json({ error: 'An active workspace member is required for this change.' }, 403);
    if (
      result.transition.outcome === 'invalid' ||
      result.transition.outcome === 'stale' ||
      result.transition.outcome === 'archived' ||
      result.transition.outcome === 'active_sibling' ||
      result.transition.outcome === 'precondition_failed' ||
      result.transition.outcome === 'merged'
    ) {
      return c.json({ error: result.transition.outcome, transition: result.transition }, 409);
    }
    return c.json({ transition: result.transition });
  });

  /** Operator correction for an ingestion mistake in the current provider-signal projection. */
  app.post('/:id/signals/:signalId/correct', requirePlatformAdmin(deps.auth), async (c) => {
    if (!deps.hub || !deps.declarationQueue)
      return c.json({ error: 'signal correction not configured' }, 503);
    const id = c.req.param('id');
    const signalId = c.req.param('signalId');
    if (!UUID_RE.test(id) || !UUID_RE.test(signalId))
      return c.json({ error: 'signal not found' }, 404);
    const { tenantId, userId } = c.get('tenant');

    let body: {
      reason?: unknown;
      requestId?: unknown;
      expectedVersion?: unknown;
      resolvedAt?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid signal correction request' }, 400);
    }
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0)
      return c.json({ error: 'reason required' }, 400);
    if (body.reason.length > 2_000) return c.json({ error: 'reason too long' }, 400);
    if (typeof body.requestId !== 'string' || !UUID_RE.test(body.requestId))
      return c.json({ error: 'requestId required' }, 400);
    if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1)
      return c.json({ error: 'invalid expectedVersion' }, 400);
    const resolvedAt =
      body.resolvedAt === undefined ? new Date() : new Date(String(body.resolvedAt));
    if (Number.isNaN(resolvedAt.getTime()) || resolvedAt.getTime() > Date.now() + 60_000)
      return c.json({ error: 'invalid resolvedAt' }, 400);

    const result = await deps.hub.correctSignal(tenantId, id, signalId, {
      reason: scrubSecrets(body.reason.trim()),
      correctionKey: `dashboard-signal-correction:${id}:${signalId}:${body.requestId}`,
      author: 'human',
      originSurface: 'dashboard',
      authorUserId: userId ?? null,
      expectedVersion: body.expectedVersion as number,
      resolvedAt,
      enqueueRecoveryTx: async (tx, context) =>
        (
          await deps.declarationQueue!.insertRecoveryTx(
            tx,
            tenantId,
            context.incidentId,
            context.lifecycleVersion,
            context.signalFence,
          )
        ).jobId,
    });
    const correction = result.correction;
    if (correction.outcome === 'not_found') return c.json({ error: 'signal not found' }, 404);
    if (correction.outcome === 'invalid') return c.json({ error: 'invalid resolvedAt' }, 400);
    if (correction.outcome === 'stale' || correction.outcome === 'archived') {
      return c.json({ error: correction.outcome }, 409);
    }
    if (correction.outcome === 'applied' && result.message) {
      await deps.hub.publishAppended(result.message).catch((error) =>
        deps.log?.error('Signal correction audit publish failed; durable audit remains stored', {
          tenantId,
          incidentId: id,
          signalId,
          messageId: result.message!.id,
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
    if (result.recoveryJobId) {
      await deps.declarationQueue.publishJob(result.recoveryJobId).catch((error) =>
        deps.log?.error('Signal correction recovery publish failed; durable job remains queued', {
          tenantId,
          incidentId: id,
          signalId,
          jobId: result.recoveryJobId,
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
    deps.log?.info('incident signal corrected', {
      tenantId,
      incidentId: id,
      signalId,
      actorUserId: userId ?? null,
      outcome: correction.outcome,
      recoveryJobCreated: Boolean(result.recoveryJobId),
    });
    return c.json({
      correction: {
        outcome: correction.outcome,
        signalId: correction.signal.id,
        version: correction.signal.version,
        resolvedAt: correction.signal.resolvedAt?.toISOString() ?? null,
      },
    });
  });

  /** Irreversibly hide a terminal incident from every user-facing surface. */
  app.post('/:id/archive', async (c) => {
    if (!deps.hub) return c.json({ error: 'incident archival not configured' }, 503);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    const incident = await getIncident(deps.db, tenantId, id);
    if (!incident) return c.json({ error: 'incident not found' }, 404);

    const body = await c.req
      .json<{
        archived?: unknown;
        reason?: unknown;
        requestId?: unknown;
        expectedVersion?: unknown;
      }>()
      .catch(() => null);
    const validDeleteRequest =
      body?.archived === true &&
      typeof body.reason === 'string' &&
      body.reason.trim().length > 0 &&
      body.reason.length <= 2_000 &&
      typeof body.requestId === 'string' &&
      UUID_RE.test(body.requestId) &&
      Number.isInteger(body.expectedVersion) &&
      (body.expectedVersion as number) >= 0;
    // A tombstone is not user-visible. Only an exact, well-formed idempotent retry may reach the Hub;
    // malformed requests must not reveal that a deleted row still exists through validation errors.
    if (incident.archivedAt && !validDeleteRequest)
      return c.json({ error: 'incident not found' }, 404);
    if (!body || typeof body.archived !== 'boolean')
      return c.json({ error: 'archived is required' }, 400);
    if (!body.archived)
      return incident.archivedAt
        ? c.json({ error: 'incident not found' }, 404)
        : c.json({ error: 'archived incidents cannot be restored' }, 400);
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0)
      return c.json({ error: 'reason required' }, 400);
    if (body.reason.length > 2_000) return c.json({ error: 'reason too long' }, 400);
    if (typeof body.requestId !== 'string' || !UUID_RE.test(body.requestId))
      return c.json({ error: 'requestId required' }, 400);
    if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0)
      return c.json({ error: 'invalid expectedVersion' }, 400);

    const result = await deps.hub.setIncidentArchived(tenantId, id, {
      archived: body.archived,
      reason: scrubSecrets(body.reason.trim()),
      archiveKey: `dashboard-archive:${id}:${body.requestId}`,
      author: 'human',
      originSurface: 'dashboard',
      authorUserId: userId ?? null,
      expectedVersion: body.expectedVersion as number,
      allowActiveSignalsForClosed: body.archived,
    });
    if (result.archive.outcome === 'not_found') return c.json({ error: 'incident not found' }, 404);
    if (result.archive.outcome === 'noop' && !result.message)
      return c.json({ error: 'incident not found' }, 404);
    if (
      result.archive.outcome === 'stale' ||
      result.archive.outcome === 'active' ||
      result.archive.outcome === 'active_signals' ||
      result.archive.outcome === 'pending_approvals' ||
      result.archive.outcome === 'work_in_progress' ||
      result.archive.outcome === 'precondition_failed'
    ) {
      return c.json({ error: result.archive.outcome, archive: result.archive }, 409);
    }
    return c.json({ archive: result.archive });
  });

  /** Evidence-backed human correction: consolidate two independently investigated incidents. */
}
