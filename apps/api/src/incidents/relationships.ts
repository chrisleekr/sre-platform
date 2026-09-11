import { scrubSecrets } from '@sre/agent-tools';
import {
  IncidentFeedbackRateLimitError,
  IncidentCorrectionConflictError,
  enforceIncidentFeedbackAdmissionTx,
  getIncidentLifecycleTx,
  getIncidentSummary,
  mergeIncidents,
  prepareResponseGroupRecoveryTx,
  recordIncidentFeedbackTx,
  recordUnrelatedIncidents,
  splitMergedIncident,
  withTenant,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import { Hono } from 'hono';
import { type TenantAuthVariables } from '../auth';

import { UUID_RE, type IncidentRouteDeps } from './support';

export function registerIncidentRelationshipRoutes(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  app.post('/:id/merge', async (c) => {
    if (!deps.hub) return c.json({ error: 'incident correction not configured' }, 503);
    const sourceIncidentId = c.req.param('id');
    if (!UUID_RE.test(sourceIncidentId)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    if (!userId) return c.json({ error: 'an attributed responder is required' }, 403);
    let body: { targetIncidentId?: unknown; rationale?: unknown; evidence?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid merge request' }, 400);
    }
    if (typeof body.targetIncidentId !== 'string' || !UUID_RE.test(body.targetIncidentId))
      return c.json({ error: 'valid targetIncidentId required' }, 400);
    const [sourceIncident, targetIncident] = await Promise.all([
      getIncidentSummary(deps.db, tenantId, sourceIncidentId),
      getIncidentSummary(deps.db, tenantId, body.targetIncidentId),
    ]);
    if (!sourceIncident || !targetIncident) return c.json({ error: 'incident not found' }, 404);
    if (
      typeof body.rationale !== 'string' ||
      !body.rationale.trim() ||
      body.rationale.length > 2_000
    )
      return c.json({ error: 'rationale required' }, 400);
    if (
      !Array.isArray(body.evidence) ||
      body.evidence.length === 0 ||
      body.evidence.length > 20 ||
      body.evidence.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2_000)
    )
      return c.json({ error: 'one to twenty evidence lines are required' }, 400);
    try {
      const rationale = scrubSecrets(body.rationale.trim());
      const evidence = body.evidence.map((item) => scrubSecrets((item as string).trim()));
      const messages: HubMessage[] = [];
      const merged = await withTenant(deps.db, tenantId, async (admissionTx) => {
        await enforceIncidentFeedbackAdmissionTx(admissionTx, tenantId, userId);
        return mergeIncidents(admissionTx, tenantId, {
          sourceIncidentId,
          targetIncidentId: body.targetIncidentId as string,
          rationale,
          evidence,
          decidedByUserId: userId,
          onCorrectedTx: async (tx, result) => {
            await recordIncidentFeedbackTx(tx, tenantId, sourceIncidentId, {
              targetType: 'correlation',
              targetId: result.relation.id,
              decision: 'group',
              rationale,
              correction: { sourceIncidentId, targetIncidentId: result.target.id },
              createdByUserId: userId,
            });
            const targetLifecycle = await getIncidentLifecycleTx(tx, result.target.id);
            if (!targetLifecycle) throw new Error('merge target lifecycle disappeared');
            messages.push(
              (
                await deps.hub!.appendTxOnce(tx, tenantId, body.targetIncidentId as string, {
                  author: 'system',
                  kind: 'relationship',
                  content: `Related alert thread joined this incident. Previous incident: ${sourceIncidentId}. Reason: ${rationale}`,
                  originSurface: 'dashboard',
                  originMessageId: `incident-merge:${result.relation.id}:target`,
                })
              ).message,
              (
                await deps.hub!.appendTxOnce(tx, tenantId, sourceIncidentId, {
                  author: 'system',
                  kind: 'relationship',
                  content: `This investigation was joined into incident ${body.targetIncidentId}. Reason: ${rationale}`,
                  originSurface: 'dashboard',
                  originMessageId: `incident-merge:${result.relation.id}:source`,
                })
              ).message,
              (
                await deps.hub!.appendTxOnce(tx, tenantId, result.target.id, {
                  author: 'system',
                  kind: 'lifecycle',
                  content: `Incident ${targetLifecycle.status}: this alert thread now follows the joined investigation ${result.target.id}.`,
                  originSurface: 'dashboard',
                  originMessageId: `incident-merge-lifecycle:${result.relation.id}`,
                  lifecycleFrom: targetLifecycle.status,
                  lifecycleTo: targetLifecycle.status,
                  lifecycleVersion: targetLifecycle.version,
                })
              ).message,
            );
          },
        });
      });
      await Promise.all(
        messages.map((message) =>
          deps.hub!.publishAppended(message).catch((error) =>
            deps.log?.error('Incident merge publish failed; durable replay will recover', {
              tenantId,
              incidentId: message.incidentId,
              operation: 'hub_publish',
              errorType: error instanceof Error ? error.name : typeof error,
            }),
          ),
        ),
      );
      return c.json({ relation: merged.relation, messageId: messages[0]?.id });
    } catch (error) {
      if (error instanceof IncidentFeedbackRateLimitError)
        return c.json({ error: error.message }, 429);
      if (error instanceof IncidentCorrectionConflictError)
        return c.json({ error: error.message }, 409);
      deps.log?.error('Incident merge failed', {
        tenantId,
        sourceIncidentId,
        operation: 'incident_merge',
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return c.json({ error: 'incident merge failed' }, 500);
    }
  });

  /** Reverse one recorded merge and restore its exact signals and Slack threads. */
  app.post('/:id/split', async (c) => {
    if (!deps.hub) return c.json({ error: 'incident correction not configured' }, 503);
    const sourceIncidentId = c.req.param('id');
    if (!UUID_RE.test(sourceIncidentId)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    if (!userId) return c.json({ error: 'an attributed responder is required' }, 403);
    let body: { targetIncidentId?: unknown; rationale?: unknown; evidence?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid split request' }, 400);
    }
    if (typeof body.targetIncidentId !== 'string' || !UUID_RE.test(body.targetIncidentId))
      return c.json({ error: 'valid targetIncidentId required' }, 400);
    const [sourceIncident, targetIncident] = await Promise.all([
      getIncidentSummary(deps.db, tenantId, sourceIncidentId),
      getIncidentSummary(deps.db, tenantId, body.targetIncidentId),
    ]);
    if (!sourceIncident || !targetIncident) return c.json({ error: 'incident not found' }, 404);
    if (
      typeof body.rationale !== 'string' ||
      !body.rationale.trim() ||
      body.rationale.length > 2_000
    )
      return c.json({ error: 'rationale required' }, 400);
    if (
      !Array.isArray(body.evidence) ||
      body.evidence.length === 0 ||
      body.evidence.length > 20 ||
      body.evidence.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2_000)
    )
      return c.json({ error: 'one to twenty evidence lines are required' }, 400);
    try {
      const rationale = scrubSecrets(body.rationale.trim());
      const evidence = body.evidence.map((item) => scrubSecrets((item as string).trim()));
      const messages: HubMessage[] = [];
      const split = await withTenant(deps.db, tenantId, async (admissionTx) => {
        await enforceIncidentFeedbackAdmissionTx(admissionTx, tenantId, userId);
        return splitMergedIncident(admissionTx, tenantId, {
          sourceIncidentId,
          targetIncidentId: body.targetIncidentId as string,
          rationale,
          evidence,
          decidedByUserId: userId,
          onCorrectedTx: async (tx, result) => {
            await recordIncidentFeedbackTx(tx, tenantId, sourceIncidentId, {
              targetType: 'correlation',
              targetId: result.relation.id,
              decision: 'separate',
              rationale,
              correction: { sourceIncidentId, targetIncidentId: result.target.id },
              createdByUserId: userId,
            });
            const sourceLifecycle = await getIncidentLifecycleTx(tx, result.source.id);
            if (!sourceLifecycle) throw new Error('split source lifecycle disappeared');
            messages.push(
              (
                await deps.hub!.appendTxOnce(tx, tenantId, sourceIncidentId, {
                  author: 'system',
                  kind: 'relationship',
                  content: `This alert is being investigated separately again. Split from incident ${body.targetIncidentId}. Reason: ${rationale}`,
                  originSurface: 'dashboard',
                  originMessageId: `incident-split:${result.relation.id}:source`,
                })
              ).message,
              (
                await deps.hub!.appendTxOnce(tx, tenantId, body.targetIncidentId as string, {
                  author: 'system',
                  kind: 'relationship',
                  content: `A previously joined alert was split back into incident ${sourceIncidentId}. Reason: ${rationale}`,
                  originSurface: 'dashboard',
                  originMessageId: `incident-split:${result.relation.id}:target`,
                })
              ).message,
              (
                await deps.hub!.appendTxOnce(tx, tenantId, result.source.id, {
                  author: 'system',
                  kind: 'lifecycle',
                  content: `Incident ${sourceLifecycle.status}: this alert thread again follows its separate investigation ${result.source.id}.`,
                  originSurface: 'dashboard',
                  originMessageId: `incident-split-lifecycle:${result.relation.id}`,
                  lifecycleFrom: sourceLifecycle.status,
                  lifecycleTo: sourceLifecycle.status,
                  lifecycleVersion: sourceLifecycle.version,
                })
              ).message,
            );
          },
        });
      });
      await Promise.all(
        messages.map((message) =>
          deps.hub!.publishAppended(message).catch((error) =>
            deps.log?.error('Incident split publish failed; durable replay will recover', {
              tenantId,
              incidentId: message.incidentId,
              operation: 'hub_publish',
              errorType: error instanceof Error ? error.name : typeof error,
            }),
          ),
        ),
      );
      return c.json({ relation: split.relation });
    } catch (error) {
      if (error instanceof IncidentFeedbackRateLimitError)
        return c.json({ error: error.message }, 429);
      if (error instanceof IncidentCorrectionConflictError)
        return c.json({ error: error.message }, 409);
      deps.log?.error('Incident split failed', {
        tenantId,
        sourceIncidentId,
        operation: 'incident_split',
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return c.json({ error: 'incident split failed' }, 500);
    }
  });

  /** Reject a burst-window candidate without merging either independently investigated incident. */
  app.post('/:id/unrelated', async (c) => {
    if (!deps.hub) return c.json({ error: 'incident correction not configured' }, 503);
    const sourceIncidentId = c.req.param('id');
    if (!UUID_RE.test(sourceIncidentId)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    if (!userId) return c.json({ error: 'an attributed responder is required' }, 403);
    let body: { targetIncidentId?: unknown; rationale?: unknown; evidence?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid unrelated request' }, 400);
    }
    if (typeof body.targetIncidentId !== 'string' || !UUID_RE.test(body.targetIncidentId))
      return c.json({ error: 'valid targetIncidentId required' }, 400);
    const [sourceIncident, targetIncident] = await Promise.all([
      getIncidentSummary(deps.db, tenantId, sourceIncidentId),
      getIncidentSummary(deps.db, tenantId, body.targetIncidentId),
    ]);
    if (!sourceIncident || !targetIncident) return c.json({ error: 'incident not found' }, 404);
    if (
      typeof body.rationale !== 'string' ||
      !body.rationale.trim() ||
      body.rationale.length > 2_000
    )
      return c.json({ error: 'rationale required' }, 400);
    if (
      !Array.isArray(body.evidence) ||
      body.evidence.length === 0 ||
      body.evidence.length > 20 ||
      body.evidence.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2_000)
    )
      return c.json({ error: 'one to twenty evidence lines are required' }, 400);
    const targetIncidentId = body.targetIncidentId;
    const rationale = scrubSecrets(body.rationale.trim());
    const evidence = body.evidence.map((item) => scrubSecrets((item as string).trim()));
    const messages: HubMessage[] = [];
    const recoveryJobIds = new Set<string>();
    try {
      const relation = await withTenant(deps.db, tenantId, async (admissionTx) => {
        await enforceIncidentFeedbackAdmissionTx(admissionTx, tenantId, userId);
        return recordUnrelatedIncidents(admissionTx, tenantId, {
          sourceIncidentId,
          targetIncidentId,
          rationale,
          evidence,
          decidedByUserId: userId,
          onRecordedTx: async (tx, recorded) => {
            await recordIncidentFeedbackTx(tx, tenantId, sourceIncidentId, {
              targetType: 'correlation',
              targetId: recorded.id,
              decision: 'separate',
              rationale,
              correction: { sourceIncidentId, targetIncidentId },
              createdByUserId: userId,
            });
            for (const [incidentId, otherIncidentId] of [
              [sourceIncidentId, targetIncidentId],
              [targetIncidentId, sourceIncidentId],
            ] as const) {
              messages.push(
                (
                  await deps.hub!.appendTxOnce(tx, tenantId, incidentId, {
                    author: 'system',
                    kind: 'relationship',
                    content: `Incident ${otherIncidentId} was ruled unrelated. Reason: ${rationale}`,
                    originSurface: 'dashboard',
                    originMessageId: `incident-unrelated:${recorded.id}:${incidentId}`,
                  })
                ).message,
              );
            }
            if (deps.declarationQueue) {
              for (const incidentId of [sourceIncidentId, targetIncidentId]) {
                const recovery = await prepareResponseGroupRecoveryTx(tx, tenantId, incidentId);
                if (!recovery) continue;
                const queued = await deps.declarationQueue.insertRecoveryTx(
                  tx,
                  tenantId,
                  recovery.rootIncidentId,
                  recovery.lifecycleVersion,
                  recovery.signalFence,
                );
                if (queued.jobId) recoveryJobIds.add(queued.jobId);
              }
            }
          },
        });
      });
      await Promise.all(
        messages.map((message) =>
          deps.hub!.publishAppended(message).catch((error) =>
            deps.log?.error('Incident relation publish failed; durable replay will recover', {
              tenantId,
              incidentId: message.incidentId,
              operation: 'hub_publish',
              errorType: error instanceof Error ? error.name : typeof error,
            }),
          ),
        ),
      );
      if (deps.declarationQueue)
        await Promise.all(
          [...recoveryJobIds].map((jobId) =>
            deps.declarationQueue!.publishJob(jobId).catch((error) =>
              deps.log?.error('Incident correction recovery dispatch failed', {
                tenantId,
                sourceIncidentId,
                jobId,
                operation: 'recovery_publish',
                errorType: error instanceof Error ? error.name : typeof error,
              }),
            ),
          ),
        );
      return c.json({ relation });
    } catch (error) {
      if (error instanceof IncidentFeedbackRateLimitError)
        return c.json({ error: error.message }, 429);
      if (error instanceof IncidentCorrectionConflictError)
        return c.json({ error: error.message }, 409);
      if (error instanceof Error && error.message === 'both incidents must exist in the tenant')
        return c.json({ error: 'incident not found' }, 404);
      deps.log?.error('Incident unrelated decision failed', {
        tenantId,
        sourceIncidentId,
        operation: 'incident_unrelated',
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return c.json({ error: 'incident relation update failed' }, 500);
    }
  });

  /** Complete canonical message history, newest page returned in display order. */
}
