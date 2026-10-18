import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  createIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  memberships,
  users,
  type HumanMessage,
} from '@sre/db';
import { RetryableError } from '@sre/queue';
import {
  admin,
  app,
  handler,
  hub,
  job,
  queue,
  recoveryJobs,
  resolvedCandidate,
  signalStates,
  tenantId,
  trackedIncident,
  useRecoveryFixture,
} from '../../classify-consumer/__tests__/recovery-report.fixture';
import { RECOVERY_NOT_QUEUED } from '../../recovery-start';
import { requestRecoveryVerification } from '../recovery-request';
import type { WorkerRuntime } from '../runtime';

useRecoveryFixture();

const memberId = randomUUID();
const strangerId = randomUUID();
const VERIFYING = 'Verifying recovery. The incident resolves only if verification confirms it.';

beforeAll(async () => {
  await admin.db.insert(users).values(
    [memberId, strangerId].map((id) => ({
      id,
      issuer: 'https://issuer.example.test/',
      subject: id,
      email: `${id}@example.test`,
    })),
  );
  await admin.db.insert(memberships).values({ tenantId, userId: memberId, role: 'member' });
});

afterAll(async () => {
  // Runs before the fixture's cleanup, so messages that reference these users go first.
  await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
  await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
  await admin.db.delete(users).where(sql`id in (${memberId}, ${strangerId})`);
});

const runtime = () => ({ deps: { appDb: app.db, hub, queue } }) as unknown as WorkerRuntime;
const resumeJob = {
  id: randomUUID(),
  tenantId,
  type: 'incident.resume' as const,
  payload: {},
  attempts: 1,
};

async function ask(incidentId: string, authorUserId: string): Promise<HumanMessage> {
  const [row] = await admin.db
    .insert(incidentMessages)
    .values({
      tenantId,
      incidentId,
      author: 'human',
      kind: 'text',
      content: 'Recheck and close if resolved',
      authorUserId,
      originSurface: 'dashboard',
    })
    .returning();
  return {
    id: row!.id,
    content: row!.content,
    originSurface: 'dashboard',
    originMessageId: null,
    authorUserId,
    createdAt: row!.createdAt,
  };
}

/** An incident whose Slack recovery report was recorded before reports started verification. */
async function reportedBeforeVerification() {
  const monitorKey = `slack:monitor-${randomUUID()}`;
  const tracked = await trackedIncident(monitorKey);
  await handler().handle(job(resolvedCandidate(monitorKey)));
  await admin.db
    .update(incidentSignals)
    .set({ state: 'unknown', clearProvenance: null, resolvedAt: null })
    .where(eq(incidentSignals.incidentId, tracked.incidentId));
  await admin.db
    .delete(jobs)
    .where(
      and(
        eq(jobs.type, 'recovery.verify'),
        sql`${jobs.payload} ->> 'incidentId' = ${tracked.incidentId}`,
      ),
    );
  return tracked;
}

const statusLines = (incidentId: string) =>
  admin.db
    .select({ content: incidentMessages.content })
    .from(incidentMessages)
    .where(
      and(
        eq(incidentMessages.incidentId, incidentId),
        sql`${incidentMessages.originMessageId} like 'recovery-request:%'`,
      ),
    );

describe('responder-requested recovery verification', () => {
  test('a recorded report starts verification once and leaves resolution to it', async () => {
    const tracked = await reportedBeforeVerification();
    const request = await ask(tracked.incidentId, memberId);

    const call = () =>
      requestRecoveryVerification(runtime(), resumeJob, tracked.incidentId, request, request.id);
    expect(await call()).toBe('handled');
    expect(await call()).toBe('handled');

    expect(await signalStates(tracked.incidentId)).toEqual([
      { state: 'resolved', clearProvenance: 'unknown' },
    ]);
    expect(await recoveryJobs(tracked.incidentId)).toHaveLength(1);
    expect(await statusLines(tracked.incidentId)).toEqual([{ content: VERIFYING }]);
    const [incident] = await admin.db
      .select({ status: incidents.status })
      .from(incidents)
      .where(eq(incidents.id, tracked.incidentId));
    expect(incident!.status).toBe('open');
  });

  test('a request after the Slack notice already queued verification reuses that job', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    await handler().handle(job(resolvedCandidate(monitorKey)));
    const request = await ask(tracked.incidentId, memberId);

    expect(
      await requestRecoveryVerification(
        runtime(),
        resumeJob,
        tracked.incidentId,
        request,
        request.id,
      ),
    ).toBe('handled');

    expect(await recoveryJobs(tracked.incidentId)).toHaveLength(1);
    expect(await statusLines(tracked.incidentId)).toEqual([{ content: VERIFYING }]);
  });

  test('a non-member changes nothing', async () => {
    const tracked = await reportedBeforeVerification();
    const request = await ask(tracked.incidentId, strangerId);

    expect(
      await requestRecoveryVerification(
        runtime(),
        resumeJob,
        tracked.incidentId,
        request,
        request.id,
      ),
    ).toBe('forbidden');

    expect((await signalStates(tracked.incidentId))[0]!.state).toBe('unknown');
    expect(await recoveryJobs(tracked.incidentId)).toHaveLength(0);
    expect((await statusLines(tracked.incidentId))[0]!.content).toMatch(
      /active, linked workspace member is required/,
    );
  });

  test('an alert with no recovery report falls back to a check', async () => {
    const tracked = await trackedIncident(`slack:monitor-${randomUUID()}`);
    const request = await ask(tracked.incidentId, memberId);

    expect(
      await requestRecoveryVerification(
        runtime(),
        resumeJob,
        tracked.incidentId,
        request,
        request.id,
      ),
    ).toBe('investigate');

    expect((await signalStates(tracked.incidentId))[0]!.state).toBe('unknown');
    expect(await recoveryJobs(tracked.incidentId)).toHaveLength(0);
    expect((await statusLines(tracked.incidentId))[0]!.content).toMatch(
      /no recorded recovery report\. Running a check instead; nothing will be resolved\.$/,
    );
  });

  test.each([
    {
      name: 'a refused verification',
      setup: async () => {
        const tracked = await reportedBeforeVerification();
        await admin.db
          .update(incidents)
          .set({ recoveryState: 'not_verified' })
          .where(eq(incidents.id, tracked.incidentId));
        return tracked.incidentId;
      },
      reason: RECOVERY_NOT_QUEUED,
    },
    {
      name: 'a case with no alerts',
      setup: async () =>
        (
          await createIncident(app.db, tenantId, {
            fingerprint: `manual-${randomUUID()}`,
            alertSource: 'manual',
            service: 'checkout',
            severity: 'sev3',
          })
        ).id,
      reason: 'Recovery verification cannot start: this case has no alerts to verify.',
    },
    {
      name: 'a case that is no longer open',
      setup: async () => {
        const tracked = await trackedIncident(`slack:monitor-${randomUUID()}`);
        await admin.db
          .update(incidents)
          .set({ status: 'resolved' })
          .where(eq(incidents.id, tracked.incidentId));
        return tracked.incidentId;
      },
      reason: 'Recovery verification cannot start: this case is no longer open.',
    },
  ])('$name says why and falls back to a check', async ({ setup, reason }) => {
    const incidentId = await setup();
    const request = await ask(incidentId, memberId);

    expect(
      await requestRecoveryVerification(runtime(), resumeJob, incidentId, request, request.id),
    ).toBe('investigate');

    expect(await recoveryJobs(incidentId)).toHaveLength(0);
    expect(await statusLines(incidentId)).toEqual([
      { content: `${reason} Running a check instead; nothing will be resolved.` },
    ]);
  });

  test('newer responder input rolls the request back for reinterpretation', async () => {
    const tracked = await reportedBeforeVerification();
    const request = await ask(tracked.incidentId, memberId);
    await ask(tracked.incidentId, memberId);

    await expect(
      requestRecoveryVerification(runtime(), resumeJob, tracked.incidentId, request, request.id),
    ).rejects.toBeInstanceOf(RetryableError);

    expect((await signalStates(tracked.incidentId))[0]!.state).toBe('unknown');
    expect(await recoveryJobs(tracked.incidentId)).toHaveLength(0);
    expect(await statusLines(tracked.incidentId)).toEqual([]);
  });
});
