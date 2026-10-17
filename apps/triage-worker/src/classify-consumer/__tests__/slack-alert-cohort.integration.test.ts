import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { alertCohortMembers, alertCohorts, incidentSignals, jobs } from '@sre/db';
import { ClassifyCore } from '../core';
import {
  CHANNEL,
  admin,
  app,
  hub,
  queue,
  redis,
  resolvedCandidate,
  tenantId,
  useRecoveryFixture,
} from './recovery-report.fixture';

useRecoveryFixture();

test('provider alerts that open incidents in one channel burst share one cohort analysis', async () => {
  const core = new ClassifyCore({
    hub,
    embedder: { dim: 1, embed: async () => [[0]] },
    appDb: app.db,
    redis,
    reservationRedis: redis,
    queue,
  } as never);
  const open = async (summary: string) => {
    const candidate = resolvedCandidate(`slack:monitor-${randomUUID()}`, {
      signalState: 'firing',
      text: `[FIRING:1] ${summary}`,
    });
    await core.openNewIncident(
      tenantId,
      `cohort-${randomUUID()}`,
      { channel: CHANNEL, threadId: candidate.externalId },
      { service: 'cluster', severity: 'sev3', title: summary },
      null,
      summary,
      core.openerFor(candidate, summary),
      async () => {},
      { signals: core.signalsFor(candidate) },
    );
  };

  await open('cloudflared pods are crash looping.');
  await open('argocd repo-server is crash looping.');

  const cohorts = await admin.db
    .select({ id: alertCohorts.id, members: sql<number>`count(${alertCohortMembers.id})::int` })
    .from(alertCohorts)
    .innerJoin(alertCohortMembers, eq(alertCohortMembers.cohortId, alertCohorts.id))
    .where(
      and(eq(alertCohorts.tenantId, tenantId), eq(alertCohorts.sourceScopeKey, `slack:${CHANNEL}`)),
    )
    .groupBy(alertCohorts.id);
  expect(cohorts).toEqual([{ id: expect.any(String), members: 2 }]);
  const analyses = await admin.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.type, 'cohort.analyze'),
        sql`${jobs.payload} ->> 'cohortId' = ${cohorts[0]!.id}`,
      ),
    );
  expect(analyses).toHaveLength(1);
  // Each member is the first signal of its own incident.
  const members = await admin.db
    .select({ incidentId: incidentSignals.incidentId })
    .from(alertCohortMembers)
    .innerJoin(incidentSignals, eq(incidentSignals.id, alertCohortMembers.signalId))
    .where(eq(alertCohortMembers.cohortId, cohorts[0]!.id));
  expect(new Set(members.map((member) => member.incidentId)).size).toBe(2);
});
