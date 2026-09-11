import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { jobs } from '@sre/db';
import { createFixture } from './queue.fixture';

const fixture = createFixture();

test.each([
  {
    type: 'cohort.analyze' as const,
    key: 'cohortId',
    insert: (value: string) =>
      fixture.db.db.transaction((tx) =>
        fixture.q.insertCohortAnalysisTx(tx, fixture.tenant, value, new Date(Date.now() + 1_000)),
      ),
  },
  {
    type: 'relation.reassess' as const,
    key: 'incidentId',
    insert: (value: string) =>
      fixture.db.db.transaction((tx) =>
        fixture.q.insertRelationReassessmentTx(tx, fixture.tenant, value),
      ),
  },
])('coalesces queued $type work while retaining one successor after claim', async (entry) => {
  const value = randomUUID();
  const first = await entry.insert(value);
  expect(first.jobId).toBeTruthy();
  expect((await entry.insert(value)).jobId).toBeNull();

  await fixture.db.db.update(jobs).set({ status: 'processing' }).where(eq(jobs.id, first.jobId!));
  const successor = await entry.insert(value);
  expect(successor.jobId).toBeTruthy();
  expect(successor.jobId).not.toBe(first.jobId);
  expect((await entry.insert(value)).jobId).toBeNull();

  await fixture.db.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, successor.jobId!));
  const later = await entry.insert(value);
  expect(later.jobId).toBeTruthy();
  expect(later.jobId).not.toBe(successor.jobId);
  await fixture.db.db
    .delete(jobs)
    .where(sql`tenant_id = ${fixture.tenant} and payload->>${entry.key} = ${value}`);
});
