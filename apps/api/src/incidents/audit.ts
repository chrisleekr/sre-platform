import {
  getIncidentEvidence,
  getIncidentSummary,
  listIncidentEvidencePage,
  listSurfaceDeliveriesForMessages,
  type EvidencePageCursor,
} from '@sre/db';
import { IncidentMovedError, IncidentUnavailableError } from '@sre/queue';
import { Hono } from 'hono';
import { applyApprovalDecision } from '../approval-decision';
import { type TenantAuthVariables } from '../auth';
import { slackAuthors } from './slack-authors';

import {
  UUID_RE,
  decodeEvidenceCursor,
  decodeMessageCursor,
  encodeEvidenceCursor,
  encodeMessageCursor,
  parseLimit,
  type IncidentRouteDeps,
} from './support';

export function registerIncidentAuditRoutes(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  app.get('/:id/messages', async (c) => {
    if (!deps.hub) return c.json({ error: 'conversation history not configured' }, 503);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId } = c.get('tenant');
    if (!(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'incident not found' }, 404);
    const cursor = c.req.query('before');
    let before: { createdAt: string; id: string } | undefined;
    if (cursor !== undefined) {
      before = decodeMessageCursor(cursor) ?? undefined;
      if (!before) return c.json({ error: 'invalid cursor' }, 400);
    }
    const limit = Math.min(parseLimit(c.req.query('limit')) ?? 100, 200);
    const rows = await deps.hub.history(tenantId, id, { limit: limit + 1, before });
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(1) : rows;
    const deliveries = await listSurfaceDeliveriesForMessages(
      deps.db,
      tenantId,
      messages.map((message) => message.id),
      id,
    );
    const slackByMessage = new Map<string, typeof deliveries>();
    for (const delivery of deliveries) {
      if (delivery.surface !== 'slack') continue;
      const messageDeliveries = slackByMessage.get(delivery.messageId) ?? [];
      messageDeliveries.push(delivery);
      slackByMessage.set(delivery.messageId, messageDeliveries);
    }
    const oldest = messages[0];
    const authors = await slackAuthors(deps.db, tenantId, messages);
    const display = await deps
      .resolveSlackDisplay?.(tenantId, messages, authors)
      .catch(() => undefined);
    return c.json({
      messages: messages.map((message) => {
        const slackDeliveries = slackByMessage.get(message.id) ?? [];
        return {
          ...message,
          ...display?.get(message.id),
          // Retained for older clients. New clients use the complete binding-scoped receipt set.
          slackDelivery: slackDeliveries[0] ?? null,
          slackDeliveries,
        };
      }),
      nextCursor:
        hasMore && oldest
          ? encodeMessageCursor({ createdAt: oldest.createdAt, id: oldest.id })
          : null,
    });
  });

  app.get('/:id/messages/:messageId/deliveries', async (c) => {
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    if (!UUID_RE.test(id) || !UUID_RE.test(messageId))
      return c.json({ error: 'message not found' }, 404);
    const { tenantId } = c.get('tenant');
    if (!(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'message not found' }, 404);
    const deliveries = await listSurfaceDeliveriesForMessages(deps.db, tenantId, [messageId], id);
    return c.json({ deliveries });
  });

  /** Bounded evidence metadata. Raw redacted input/output is loaded only when one row is expanded. */
  app.get('/:id/evidence', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId } = c.get('tenant');
    if (!(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'incident not found' }, 404);
    const cursor = c.req.query('before');
    let before: EvidencePageCursor | undefined;
    if (cursor !== undefined) {
      before = decodeEvidenceCursor(cursor) ?? undefined;
      if (!before) return c.json({ error: 'invalid cursor' }, 400);
    }
    const page = await listIncidentEvidencePage(deps.db, tenantId, id, {
      limit: parseLimit(c.req.query('limit')),
      before,
    });
    return c.json({
      evidence: page.evidence,
      nextCursor: page.nextCursor ? encodeEvidenceCursor(page.nextCursor) : null,
    });
  });

  app.get('/:id/evidence/:evidenceId', async (c) => {
    const id = c.req.param('id');
    const evidenceId = c.req.param('evidenceId');
    if (!UUID_RE.test(id) || !UUID_RE.test(evidenceId))
      return c.json({ error: 'evidence not found' }, 404);
    const { tenantId } = c.get('tenant');
    if (!(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'incident not found' }, 404);
    const evidence = await getIncidentEvidence(deps.db, tenantId, id, evidenceId);
    if (!evidence) return c.json({ error: 'evidence not found' }, 404);
    return c.json(evidence);
  });

  // `POST /incidents/:id/generate-runbook` — a human commands runbook generation from a resolved or
  // investigated incident. Enqueues a durable job and returns immediately; the LLM runs
  // off the request path in the triage-worker's runbook consumer. Open to any authed tenant
  // member (flat membership); RLS scopes the incident lookup to the caller's tenant.
  app.post('/:id/generate-runbook', async (c) => {
    if (!deps.runbookQueue) return c.json({ error: 'runbook generation not configured' }, 503);
    const { tenantId, sub } = c.get('tenant');
    const id = c.req.param('id');
    // A non-uuid id would make Postgres raise 22P02 (a 500); treat it as not-found before the query.
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    // Verify the incident exists under this tenant (RLS): a missing or foreign incident is 404.
    const incident = await getIncidentSummary(deps.db, tenantId, id);
    if (!incident) return c.json({ error: 'incident not found' }, 404);

    try {
      const jobId = await deps.runbookQueue.enqueue({
        tenantId,
        type: 'runbook.generate',
        payload: { incidentId: id, requestedBy: sub },
      });
      return c.json({ jobId }, 202);
    } catch (error) {
      if (error instanceof IncidentUnavailableError)
        return c.json({ error: 'incident not found' }, 404);
      if (error instanceof IncidentMovedError)
        return c.json(
          {
            error: 'incident was joined into another investigation',
            targetIncidentId: error.targetIncidentId,
          },
          409,
        );
      throw error;
    }
  });

  // `POST /incidents/:id/approvals/:approvalId/decide` — a human decides a pending approval from the
  // dashboard. Applies the first-decision-wins CAS, appends a 'decided: <label>' reply
  // (origin_surface='dashboard' so the fan-out syncs it to Slack), and enqueues a resume so the engine
  // continues off the request path. Open to any authed tenant member (flat membership); the
  // cross-tenant guard + tenant-scoped CAS keep it to the caller's own approval.
  app.post('/:id/approvals/:approvalId/decide', async (c) => {
    if (!deps.adminDb || !deps.hub || !deps.resumeQueue)
      return c.json({ error: 'approvals not configured' }, 503);
    const { tenantId, sub, userId } = c.get('tenant');
    const id = c.req.param('id');
    const approvalId = c.req.param('approvalId');

    if (!UUID_RE.test(id) || !(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'incident not found' }, 404);

    let optionId: unknown;
    try {
      optionId = ((await c.req.json()) as { optionId?: unknown }).optionId;
    } catch {
      optionId = undefined;
    }
    if (typeof optionId !== 'string') return c.json({ error: 'optionId required' }, 400);

    const outcome = await applyApprovalDecision(
      { adminDb: deps.adminDb, appDb: deps.db, hub: deps.hub, queue: deps.resumeQueue },
      {
        tenantId,
        approvalId,
        optionId,
        decidedBy: userId ?? sub,
        originSurface: 'dashboard',
        expectedIncidentId: id,
        // attribute the decision to the authenticated member. `userId` only, never `sub`: `sub` is an
        // Auth0 subject ('auth0|abc'), not a uuid, so it would fail uuid parsing (22P02) — and nothing would
        // tenant-check it even if it parsed, since author_user_id is a plain FK to users.id. `userId` is
        // populated only on a resolved membership (auth.ts), which is what makes it safe to stamp. A caller
        // without one decides unattributed rather than not at all.
        authorUserId: userId ?? null,
      },
    );
    switch (outcome.status) {
      case 'decided':
        return c.json({ decided: true, label: outcome.label });
      case 'already_decided':
        return c.json({ decided: false }, 409);
      case 'invalid_option':
        return c.json({ error: 'invalid option' }, 400);
      case 'not_found':
        return c.json({ error: 'approval not found' }, 404);
    }
  });
}
