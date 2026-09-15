import { Hono } from 'hono';
import { scrubSecrets } from '@sre/agent-tools';
import { routeToIncident, type RouteDeps } from '@sre/alerts';
import type { Queue } from '@sre/queue';
import {
  SEMANTIC_DISPOSITION_CONTRACT_VERSION,
  SIGNAL_DISPOSITION_CORPUS_SIZE,
  SIGNAL_DISPOSITION_CORPUS_VERSION,
} from '@sre/contracts';
import {
  getSignalDisposition,
  getTenantSignalPolicy,
  latestSignalDispositionEvaluation,
  listTenantTagLinkRules,
  listSignalDispositionPage,
  lockSignalTicketForPromotionTx,
  markSignalPromotedTx,
  approveSignalDispositionEnforcement,
  effectiveSignalClassificationMode,
  requestSignalDispositionEvaluation,
  removeTenantTagLinkRule,
  returnSignalDispositionToShadow,
  signalPromotionStats,
  setTenantSignalPolicy,
  setTenantTagLinkRule,
  startSignalReview,
  isActionableSignalTicket,
  type SignalPageCursor,
  type Db,
} from '@sre/db';
import {
  authMiddleware,
  requirePlatformAdmin,
  type AuthDeps,
  type TenantAuthVariables,
  refuseImpersonatedChange,
} from './auth';

interface SignalRouteDeps {
  auth: AuthDeps;
  db: Db;
  route: RouteDeps;
  evaluationQueue: {
    insertJobTx: Queue['insertJobTx'];
    publishJob(jobId: string): Promise<void>;
  };
  runtimeFingerprint(): Promise<string>;
}

const CRITERIA = new Set(['second_team', 'customer_visible', 'unsolved', 'other']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeSignalCursor(cursor: SignalPageCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString(
    'base64url',
  );
}

function decodeSignalCursor(raw: string): SignalPageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== 'string' || typeof id !== 'string' || !UUID_RE.test(id)) return null;
    const date = new Date(createdAt);
    return Number.isNaN(date.getTime()) ? null : { createdAt: date, id };
  } catch {
    return null;
  }
}

function promotionBody(value: unknown): { criterion: string; reason: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['criterion', 'reason'].includes(key))) return null;
  if (typeof record.criterion !== 'string' || !CRITERIA.has(record.criterion)) return null;
  if (typeof record.reason !== 'string') return null;
  const reason = scrubSecrets(record.reason.trim());
  return reason && reason.length <= 2_000 ? { criterion: record.criterion, reason } : null;
}

async function waitForPromotion(db: Db, tenantId: string, signalId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await getSignalDisposition(db, tenantId, signalId);
    if (row?.incidentId) return row.incidentId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

async function signalPolicyState(deps: SignalRouteDeps, tenantId: string) {
  const [policy, evaluation, runtimeFingerprint] = await Promise.all([
    getTenantSignalPolicy(deps.db, tenantId),
    latestSignalDispositionEvaluation(deps.db, tenantId),
    deps.runtimeFingerprint(),
  ]);
  let enforcementIneligibleReason: string | null = null;
  if (!evaluation) enforcementIneligibleReason = 'No runtime evaluation has completed.';
  else if (evaluation.status !== 'completed')
    enforcementIneligibleReason = `The latest evaluation is ${evaluation.status}.`;
  else if (evaluation.failureCategory)
    enforcementIneligibleReason = `The latest evaluation failed: ${evaluation.failureCategory}.`;
  else if (evaluation.criticalSafetyMisses !== 0)
    enforcementIneligibleReason = 'The evaluation contains a critical-safety miss.';
  else if (
    evaluation.total !== SIGNAL_DISPOSITION_CORPUS_SIZE ||
    evaluation.correct !== evaluation.total
  )
    enforcementIneligibleReason = 'The evaluation does not perfectly match the reviewed corpus.';
  else if (
    !Array.isArray(evaluation.scenarioResults) ||
    evaluation.scenarioResults.length !== SIGNAL_DISPOSITION_CORPUS_SIZE
  )
    enforcementIneligibleReason = 'The evaluation is missing reviewed scenario results.';
  else if (
    evaluation.corpusVersion !== SIGNAL_DISPOSITION_CORPUS_VERSION ||
    evaluation.contractVersion !== SEMANTIC_DISPOSITION_CONTRACT_VERSION
  )
    enforcementIneligibleReason = 'The evaluation is stale for the current classifier contract.';
  else if (evaluation.runtimeFingerprint !== runtimeFingerprint)
    enforcementIneligibleReason = 'The evaluation is stale for the current model runtime.';
  return {
    policy,
    evaluation,
    effectiveClassificationMode: effectiveSignalClassificationMode(policy, runtimeFingerprint),
    enforcementEligibility: {
      eligible: enforcementIneligibleReason === null,
      reason: enforcementIneligibleReason,
    },
  };
}

/** Authenticated signal review and promotion routes. */
export function signalRoutes(deps: SignalRouteDeps): Hono<{ Variables: TenantAuthVariables }> {
  const app = new Hono<{ Variables: TenantAuthVariables }>();
  app.use('*', authMiddleware(deps.auth));
  // Reviewing and promoting a signal is member work on the workspace's own backlog, and promoting
  // one opens an incident, so a support session does neither. The policy and tag-link routes are
  // exempt: they already require platform-operator rights, and impersonation is the only way an
  // operator reaches a tenant context at all, so refusing them would leave them unreachable.
  app.use(
    '*',
    refuseImpersonatedChange({ except: /^\/signals\/(policy|evaluations|tag-link-rules)(\/|$)/ }),
  );
  app.get('/policy', async (c) => c.json(await signalPolicyState(deps, c.get('tenant').tenantId)));
  app.put('/policy', requirePlatformAdmin(deps.auth), async (c) => {
    const tenant = c.get('tenant');
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid policy' }, 400);
    const retentionDays = Number(body.retentionDays);
    const unsolvedAfterMinutes =
      body.unsolvedAfterMinutes === null ? null : Number(body.unsolvedAfterMinutes);
    if (
      Object.keys(body).some(
        (key) =>
          ![
            'retentionDays',
            'unsolvedAfterMinutes',
            'secondTeamEnabled',
            'customerVisibleEnabled',
          ].includes(key),
      ) ||
      typeof body.secondTeamEnabled !== 'boolean' ||
      typeof body.customerVisibleEnabled !== 'boolean'
    )
      return c.json({ error: 'invalid policy' }, 400);
    try {
      const policy = await setTenantSignalPolicy(deps.db, tenant.tenantId, {
        retentionDays,
        unsolvedAfterMinutes,
        secondTeamEnabled: body.secondTeamEnabled,
        customerVisibleEnabled: body.customerVisibleEnabled,
      });
      return c.json({ policy });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'invalid policy' }, 400);
    }
  });
  app.post('/evaluations', requirePlatformAdmin(deps.auth), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant.userId) return c.json({ error: 'operator identity is unavailable' }, 403);
    const runtimeFingerprint = await deps.runtimeFingerprint();
    const requested = await requestSignalDispositionEvaluation(deps.db, tenant.tenantId, {
      requestedByUserId: tenant.userId,
      runtimeFingerprint,
      insertJobTx: deps.evaluationQueue.insertJobTx.bind(deps.evaluationQueue),
    });
    if (!requested.evaluation.jobId) {
      return c.json({ error: 'evaluation has no durable job' }, 503);
    }
    try {
      await deps.evaluationQueue.publishJob(requested.evaluation.jobId);
    } catch {
      return c.json(
        { error: 'evaluation is durable but dispatch is temporarily unavailable' },
        503,
      );
    }
    return c.json({ evaluation: requested.evaluation }, 202);
  });
  app.post('/policy/enforce', requirePlatformAdmin(deps.auth), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant.userId) return c.json({ error: 'operator identity is unavailable' }, 403);
    const body = (await c.req.json().catch(() => null)) as {
      evaluationId?: unknown;
      reviewedTicketScenarioIds?: unknown;
    } | null;
    if (
      !body ||
      typeof body.evaluationId !== 'string' ||
      !Array.isArray(body.reviewedTicketScenarioIds) ||
      body.reviewedTicketScenarioIds.some((id) => typeof id !== 'string')
    ) {
      return c.json({ error: 'evaluation id and reviewed ticket scenarios are required' }, 400);
    }
    try {
      await approveSignalDispositionEnforcement(deps.db, tenant.tenantId, {
        evaluationId: body.evaluationId,
        userId: tenant.userId,
        runtimeFingerprint: await deps.runtimeFingerprint(),
        reviewedTicketScenarioIds: [...new Set(body.reviewedTicketScenarioIds as string[])],
      });
      return c.json(await signalPolicyState(deps, tenant.tenantId));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'enforcement approval failed' },
        409,
      );
    }
  });
  app.post('/policy/shadow', requirePlatformAdmin(deps.auth), async (c) => {
    const tenantId = c.get('tenant').tenantId;
    await returnSignalDispositionToShadow(deps.db, tenantId);
    return c.json(await signalPolicyState(deps, tenantId));
  });
  app.put('/tag-link-rules', requirePlatformAdmin(deps.auth), async (c) => {
    const tenantId = c.get('tenant').tenantId;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      Object.keys(body).some((key) => !['prefix', 'urlTemplate'].includes(key)) ||
      typeof body.prefix !== 'string' ||
      typeof body.urlTemplate !== 'string'
    ) {
      return c.json({ error: 'prefix and URL template are required' }, 400);
    }
    try {
      return c.json({
        rule: await setTenantTagLinkRule(deps.db, tenantId, {
          prefix: body.prefix,
          urlTemplate: body.urlTemplate,
        }),
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'invalid tag link rule' },
        400,
      );
    }
  });
  app.delete('/tag-link-rules/:prefix', requirePlatformAdmin(deps.auth), async (c) => {
    try {
      const removed = await removeTenantTagLinkRule(
        deps.db,
        c.get('tenant').tenantId,
        c.req.param('prefix'),
      );
      return removed ? c.body(null, 204) : c.json({ error: 'tag link rule not found' }, 404);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'invalid tag link rule' },
        400,
      );
    }
  });
  app.get('/', async (c) => {
    const tenantId = c.get('tenant').tenantId;
    const raw = c.req.query('disposition');
    const disposition =
      raw === 'investigate' || raw === 'ticket' || raw === 'log' ? raw : undefined;
    const cursorRaw = c.req.query('cursor');
    const before = cursorRaw ? decodeSignalCursor(cursorRaw) : undefined;
    if (cursorRaw && !before) return c.json({ error: 'invalid cursor' }, 400);
    const [page, promotion, state, tagLinkRules] = await Promise.all([
      listSignalDispositionPage(deps.db, tenantId, {
        limit: Math.min(50, Number(c.req.query('limit') ?? 50) || 50),
        disposition,
        currentOnly: true,
        before: before ?? undefined,
      }),
      signalPromotionStats(deps.db, tenantId),
      signalPolicyState(deps, tenantId),
      listTenantTagLinkRules(deps.db, tenantId),
    ]);
    return c.json({
      signals: page.signals.map((signal) => ({
        ...signal,
        actionableTicket: isActionableSignalTicket(signal),
      })),
      nextCursor: page.nextCursor ? encodeSignalCursor(page.nextCursor) : null,
      promotion,
      ...state,
      tagLinkRules,
    });
  });
  app.post('/:id/review', async (c) => {
    const tenantId = c.get('tenant').tenantId;
    const signal = await startSignalReview(deps.db, tenantId, c.req.param('id'));
    return signal ? c.json({ signal }) : c.json({ error: 'ticket not found' }, 404);
  });
  app.post('/:id/promote', async (c) => {
    const tenant = c.get('tenant');
    const body = promotionBody(await c.req.json().catch(() => null));
    if (!body) return c.json({ error: 'invalid promotion request' }, 400);
    const signal = await getSignalDisposition(deps.db, tenant.tenantId, c.req.param('id'));
    if (!signal) return c.json({ error: 'signal not found' }, 404);
    if (signal.incidentId) return c.json({ incidentId: signal.incidentId });
    if (!isActionableSignalTicket(signal))
      return c.json({ error: 'signal is not an open ticket' }, 409);
    const policy = await getTenantSignalPolicy(deps.db, tenant.tenantId);
    if (
      (body.criterion === 'second_team' && !policy.secondTeamEnabled) ||
      (body.criterion === 'customer_visible' && !policy.customerVisibleEnabled)
    ) {
      return c.json({ error: 'the selected declaration criterion is disabled' }, 409);
    }
    if (body.criterion === 'unsolved') {
      if (policy.unsolvedAfterMinutes === null || signal.reviewStartedAt === null) {
        return c.json(
          { error: 'unsolved promotion requires an enabled threshold and a started review' },
          409,
        );
      }
      if (signal.reviewStartedAt.getTime() + policy.unsolvedAfterMinutes * 60_000 > Date.now()) {
        return c.json({ error: 'the unsolved review threshold has not elapsed' }, 409);
      }
    }

    let routed: Awaited<ReturnType<typeof routeToIncident>>;
    try {
      routed = await routeToIncident(deps.route, {
        tenantId: tenant.tenantId,
        source: signal.source,
        fingerprint: `signal-ticket:${signal.id}`,
        dedupKey: `signal-ticket:${signal.id}:promote`,
        service: signal.service ?? 'unknown',
        severity: signal.severity ?? 'sev3',
        title: signal.summary,
        context: { signalDispositionId: signal.id, summary: signal.summary },
        origin: {
          surface: signal.surface as 'slack',
          channel: signal.channel,
          threadId: signal.threadId,
        },
        investigationTrigger: {
          reason: 'manual_investigation',
          automatic: false,
          monitorKey: `signal-ticket:${signal.id}`,
        },
        onRoutedTx: async (tx, result) => {
          const current = await lockSignalTicketForPromotionTx(tx, signal.id, body.criterion);
          if (!current) throw new Error('signal ticket is no longer promotable');
          if (current.incidentId) {
            if (current.incidentId !== result.incidentId)
              throw new Error('signal ticket is already linked to another incident');
            return;
          }
          const promoted = await markSignalPromotedTx(tx, signal.id, {
            incidentId: result.incidentId,
            userId: tenant.userId ?? null,
            surface: 'dashboard',
            actor: `${tenant.issuer}|${tenant.sub}`,
            criterion: body.criterion,
            reason: body.reason,
          });
          if (!promoted) throw new Error('signal ticket promotion lost its attribution race');
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith('unsolved promotion') ||
          error.message === 'the unsolved review threshold has not elapsed')
      ) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
    const incidentId =
      routed.incidentId ?? (await waitForPromotion(deps.db, tenant.tenantId, signal.id));
    return incidentId
      ? c.json({ incidentId })
      : c.json({ error: 'promotion is still being processed' }, 503);
  });
  return app;
}
