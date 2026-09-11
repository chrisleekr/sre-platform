import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { createIncident, incidents, recordToolCall } from '@sre/db';

import { eq, sql } from 'drizzle-orm';

import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('investigation-run projections', () => {
  test('returns latest run metadata separately from the trusted brief and citations', async () => {
    const { id: incidentId } = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `latest-run-projection-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const evidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantC, {
      incidentId,
      tool: 'query_metrics',
      input: { service: 'checkout' },
      output: { errorRate: 0.42 },
      latencyMs: 5,
      outcome: 'data',
    });
    const trustedSummary = 'Connection pool saturation remains the trusted assessment.';
    await __fixture.admin.db
      .update(incidents)
      .set({
        investigationStatus: 'assessed',
        rcaSummary: trustedSummary,
        confidence: 88,
        assessmentEvidenceIds: [evidenceId],
        assessmentUpdatedAt: new Date('2026-08-31T00:00:00.000Z'),
      })
      .where(eq(incidents.id, incidentId));

    const trustedRunId = randomUUID();
    const runId = randomUUID();
    const trustedStartedAt = new Date('2026-08-31T00:00:00.000Z');
    const trustedCompletedAt = new Date('2026-08-31T00:00:30.000Z');
    const startedAt = new Date('2026-08-31T00:01:00.000Z');
    const completedAt = new Date('2026-08-31T00:02:00.000Z');
    let inserted = false;
    try {
      await __fixture.admin.db.execute(sql`
        insert into investigation_runs (
          id,
          tenant_id,
          incident_id,
          operation,
          provider,
          engine_model,
          engine_session_id,
          turn_budget,
          outcome,
          result,
          evidence_ids,
          started_at,
          completed_at
        ) values (
          ${trustedRunId},
          ${__fixture.tenantC},
          ${incidentId},
          'investigate',
          'anthropic',
          'claude-test',
          ${`session:${trustedRunId}`},
          8,
          'conclusive',
          ${JSON.stringify({ summary: trustedSummary })}::jsonb,
          array[${evidenceId}::uuid],
          ${trustedStartedAt.toISOString()},
          ${trustedCompletedAt.toISOString()}
        )
      `);
      inserted = true;
      await __fixture.admin.db
        .update(incidents)
        .set({ trustedAssessmentRunId: trustedRunId })
        .where(eq(incidents.id, incidentId));
      await __fixture.admin.db.execute(sql`
        insert into investigation_runs (
          id,
          tenant_id,
          incident_id,
          job_id,
          operation,
          trigger_reason,
          trigger_automatic,
          trigger_monitor_key,
          trigger_monitor_keys,
          trigger_budget,
          provider,
          engine_model,
          engine_session_id,
          turn_budget,
          outcome,
          result,
          evidence_ids,
          started_at,
          completed_at
        ) values (
          ${runId},
          ${__fixture.tenantC},
          ${incidentId},
          ${runId},
          'investigate',
          'new_episode',
          true,
          'alertmanager:checkout-errors',
          array['alertmanager:checkout-errors']::text[],
          ${JSON.stringify({
            windowHours: 24,
            tenant: {
              runs: 10,
              configuredCostUsd: 5,
              pendingCostRuns: 0,
              missingUsageRuns: 0,
              unpricedRuns: 0,
              runLimit: 10,
              configuredCostLimitUsd: 0,
            },
            monitors: [
              {
                monitorKey: 'alertmanager:checkout-errors',
                runs: 3,
                configuredCostUsd: 2,
                pendingCostRuns: 0,
                missingUsageRuns: 0,
                unpricedRuns: 0,
                runLimit: 3,
                configuredCostLimitUsd: 0,
              },
            ],
            exhaustedBy: ['tenant_run_limit', 'monitor_run_limit'],
          })}::jsonb,
          'anthropic',
          'claude-test',
          ${`session:${runId}`},
          8,
          'budget_exhausted',
          ${JSON.stringify({ reason: 'exploration budget exhausted' })}::jsonb,
          array[${evidenceId}::uuid],
          ${startedAt.toISOString()},
          ${completedAt.toISOString()}
        )
      `);

      const token = await __fixture.sign(__fixture.orgC);
      const listed = await __fixture.api.request('/incidents', __fixture.auth(token));
      expect(listed.status).toBe(200);
      const listBody = (await listed.json()) as {
        incidents: Array<Record<string, unknown> & { id: string }>;
      };
      expect(listBody.incidents.find((incident) => incident.id === incidentId)).toMatchObject({
        rcaSummary: trustedSummary,
        latestInvestigationRun: {
          id: runId,
          operation: 'investigate',
          outcome: 'budget_exhausted',
          triggerReason: 'new_episode',
          triggerAutomatic: true,
          triggerMonitorKey: 'alertmanager:checkout-errors',
          triggerMonitorKeys: ['alertmanager:checkout-errors'],
          triggerBudget: {
            exhaustedBy: ['tenant_run_limit', 'monitor_run_limit'],
          },
          completedAt: completedAt.toISOString(),
        },
      });

      const workspaceResponse = await __fixture.api.request(
        `/incidents/${incidentId}/workspace`,
        __fixture.auth(token),
      );
      expect(workspaceResponse.status).toBe(200);
      await expect(workspaceResponse.json()).resolves.toMatchObject({
        incident: {
          rcaSummary: trustedSummary,
          assessmentEvidenceIds: [evidenceId],
          latestInvestigationRun: {
            id: runId,
            operation: 'investigate',
            outcome: 'budget_exhausted',
            triggerReason: 'new_episode',
            triggerAutomatic: true,
            triggerMonitorKey: 'alertmanager:checkout-errors',
            triggerMonitorKeys: ['alertmanager:checkout-errors'],
            triggerBudget: {
              exhaustedBy: ['tenant_run_limit', 'monitor_run_limit'],
            },
            completedAt: completedAt.toISOString(),
          },
        },
      });
    } finally {
      if (inserted) {
        await __fixture.admin.db
          .update(incidents)
          .set({ trustedAssessmentRunId: null })
          .where(eq(incidents.id, incidentId));
        await __fixture.admin.db.execute(
          sql`delete from investigation_runs where tenant_id = ${__fixture.tenantC} and id in (${trustedRunId}, ${runId})`,
        );
      }
    }
  });
});
