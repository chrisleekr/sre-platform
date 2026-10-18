import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { alertCohortMembers, alertCohorts, incidentSignals, jobs } from '@sre/db';
import { makeClassifyHandler } from '../../classify-consumer';
import { makeFakeClassifier } from '../../engine/classify';
import { ClassifyCore } from '../core';
import {
  CHANNEL,
  admin,
  app,
  hub,
  job,
  queue,
  redis,
  resolvedCandidate,
  tenantId,
  useRecoveryFixture,
} from './recovery-report.fixture';

useRecoveryFixture();

const deps = () => ({
  hub,
  embedder: { dim: 1, embed: async () => [[0]] },
  appDb: app.db,
  redis,
  reservationRedis: redis,
  queue,
});

const cohortMembers = (channel: string) =>
  admin.db
    .select({ id: alertCohorts.id, members: sql<number>`count(${alertCohortMembers.id})::int` })
    .from(alertCohorts)
    .innerJoin(alertCohortMembers, eq(alertCohortMembers.cohortId, alertCohorts.id))
    .where(
      and(eq(alertCohorts.tenantId, tenantId), eq(alertCohorts.sourceScopeKey, `slack:${channel}`)),
    )
    .groupBy(alertCohorts.id);

const firing = (channel: string, summary: string) =>
  resolvedCandidate(`slack:monitor-${randomUUID()}`, {
    channel,
    signalState: 'firing',
    text: `[FIRING:1] ${summary}`,
  });

test('provider alerts that open incidents in one channel burst share one cohort analysis', async () => {
  const core = new ClassifyCore(deps() as never);
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

test('provider alerts opened while the classifier fails open still share one cohort', async () => {
  const channel = `C-FAILOPEN-${randomUUID().slice(0, 8)}`;
  const handle = makeClassifyHandler({
    ...deps(),
    classify: makeFakeClassifier(() => {
      throw new Error('classifier unavailable');
    }),
  });

  await handle(job(firing(channel, 'cloudflared pods are crash looping.')));
  await handle(job(firing(channel, 'argocd repo-server is crash looping.')));

  expect(await cohortMembers(channel)).toEqual([{ id: expect.any(String), members: 2 }]);
});

test('an incident a person opens does not join the channel cohort', async () => {
  const channel = `C-HUMAN-${randomUUID().slice(0, 8)}`;
  const core = new ClassifyCore(deps() as never);
  const candidate = { ...firing(channel, 'checkout looks slow to me'), author: 'human' as const };

  await core.openNewIncident(
    tenantId,
    `cohort-${randomUUID()}`,
    { channel, threadId: candidate.externalId },
    { service: 'checkout', severity: 'sev3', title: 'Checkout looks slow' },
    null,
    candidate.text,
    core.openerFor(candidate, candidate.text),
    async () => {},
    { signals: core.signalsFor(candidate) },
  );

  expect(await cohortMembers(channel)).toEqual([]);
});
