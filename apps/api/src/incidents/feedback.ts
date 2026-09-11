import { scrubSecrets } from '@sre/agent-tools';
import {
  IncidentFeedbackRateLimitError,
  enforceIncidentFeedbackAdmissionTx,
  incidents,
  incidentMessages,
  incidentSignals,
  recordIncidentFeedbackTx,
  upsertHumanAssessmentGradeTx,
  withTenant,
} from '@sre/db';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { type TenantAuthVariables } from '../auth';
import { UUID_RE, type IncidentRouteDeps } from './support';

type DirectFeedback =
  | {
      targetType: 'finding';
      targetId: string;
      decision: 'confirm' | 'correct';
      rationale: string;
      replacement: string | null;
    }
  | {
      targetType: 'noise';
      targetId: string;
      decision: 'noise' | 'not_noise';
      rationale: string;
      replacement: null;
    };

function parseFeedback(value: unknown): DirectFeedback | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(['targetType', 'targetId', 'decision', 'rationale', 'replacement']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (typeof body.targetId !== 'string' || !UUID_RE.test(body.targetId)) return null;
  if (
    typeof body.rationale !== 'string' ||
    !body.rationale.trim() ||
    body.rationale.trim().length > 1_000
  )
    return null;
  const rationale = scrubSecrets(body.rationale.trim());
  if (body.targetType === 'finding' && ['confirm', 'correct'].includes(String(body.decision))) {
    const replacement =
      body.decision === 'correct' &&
      typeof body.replacement === 'string' &&
      body.replacement.trim() &&
      body.replacement.trim().length <= 4_000
        ? scrubSecrets(body.replacement.trim())
        : body.decision === 'confirm' &&
            (body.replacement === undefined || body.replacement === null)
          ? null
          : false;
    if (replacement === false) return null;
    return {
      targetType: 'finding',
      targetId: body.targetId,
      decision: body.decision as 'confirm' | 'correct',
      rationale,
      replacement,
    };
  }
  if (
    body.targetType === 'noise' &&
    (body.decision === 'noise' || body.decision === 'not_noise') &&
    (body.replacement === undefined || body.replacement === null)
  ) {
    return {
      targetType: 'noise',
      targetId: body.targetId,
      decision: body.decision,
      rationale,
      replacement: null,
    };
  }
  return null;
}

/** Registers attributed finding and alert-noise feedback commands. */
export function registerIncidentFeedbackRoutes(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  app.post('/:id/feedback', async (c) => {
    const incidentId = c.req.param('id');
    if (!UUID_RE.test(incidentId)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    if (!userId) return c.json({ error: 'an attributed responder is required' }, 403);
    let parsed: DirectFeedback | null = null;
    try {
      parsed = parseFeedback(await c.req.json());
    } catch {
      parsed = null;
    }
    if (!parsed) return c.json({ error: 'invalid incident feedback' }, 400);
    const feedback = parsed;
    const record = () =>
      withTenant(deps.db, tenantId, async (tx) => {
        await enforceIncidentFeedbackAdmissionTx(tx, tenantId, userId);
        const incident = await tx
          .select({ id: incidents.id, archivedAt: incidents.archivedAt })
          .from(incidents)
          .where(eq(incidents.id, incidentId))
          .limit(1)
          .for('update');
        if (!incident[0] || incident[0].archivedAt) return { outcome: 'not_found' as const };
        const target =
          feedback.targetType === 'finding'
            ? await tx
                .select({ id: incidentMessages.id })
                .from(incidentMessages)
                .where(
                  and(
                    eq(incidentMessages.incidentId, incidentId),
                    sql`${incidentMessages.finding} is not null`,
                    sql`${incidentMessages.finding}->>'runId' = ${feedback.targetId}`,
                    sql`${incidentMessages.finding}->>'outcome' = 'conclusive'`,
                  ),
                )
                .limit(1)
            : await tx
                .select({ id: incidentSignals.id })
                .from(incidentSignals)
                .where(
                  and(
                    eq(incidentSignals.id, feedback.targetId),
                    eq(incidentSignals.incidentId, incidentId),
                  ),
                )
                .limit(1)
                .for('update');
        if (!target[0]) return { outcome: 'not_found' as const };
        const recorded = await recordIncidentFeedbackTx(tx, tenantId, incidentId, {
          targetType: feedback.targetType,
          targetId: feedback.targetId,
          decision: feedback.decision,
          rationale: feedback.rationale,
          correction: feedback.replacement ? { replacement: feedback.replacement } : null,
          createdByUserId: userId,
        });
        // A finding verdict IS an RCA grade: targetId is the run that produced the assessment.
        // Same transaction, so a grade can never exist without the feedback that justifies it.
        // 'correct' means the responder replaced the finding, i.e. the model was wrong. A run that
        // claimed no confidence records feedback only.
        if (feedback.targetType === 'finding') {
          await upsertHumanAssessmentGradeTx(tx, tenantId, {
            incidentId,
            runId: feedback.targetId,
            verdict: feedback.decision === 'confirm' ? 'correct' : 'incorrect',
            rationale: feedback.rationale,
            gradedByUserId: userId,
          });
        }
        return { outcome: 'recorded' as const, feedback: recorded };
      });
    let result: Awaited<ReturnType<typeof record>>;
    try {
      result = await record();
    } catch (error) {
      if (error instanceof IncidentFeedbackRateLimitError)
        return c.json({ error: error.message }, 429);
      throw error;
    }
    if (result.outcome === 'not_found') return c.json({ error: 'feedback target not found' }, 404);
    return c.json({ feedback: result.feedback }, 201);
  });
}
