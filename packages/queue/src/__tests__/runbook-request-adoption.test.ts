import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createIncident, jobs } from '@sre/db';
import { AutomaticPassFinishingError } from '../queue';
import { createFixture } from './queue.fixture';

// A responder's runbook request that coalesces onto a pending automatic pass must still be answered.
// The automatic pass is silent when it finds nothing, so the pending row adopts the request payload.
const __fixture = createFixture();
const RUNBOOK = 'runbook.generate';

async function incident(): Promise<string> {
  return (
    await createIncident(__fixture.db.db, __fixture.tenant, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'adoption',
      severity: 'sev3',
    })
  ).id;
}

const payloadOf = async (id: string) =>
  (await __fixture.db.db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, id)))[0]
    ?.payload;

describe('runbook request adoption', () => {
  test.each(['queued', 'processing'] as const)(
    'a %s automatic pass adopts a responder request, capture fence included',
    async (status) => {
      const incidentId = await incident();
      const automaticId = await __fixture.q.enqueue({
        tenantId: __fixture.tenant,
        type: RUNBOOK,
        payload: { incidentId, automatic: true },
      });
      await __fixture.db.db.update(jobs).set({ status }).where(eq(jobs.id, automaticId));

      const requestId = await __fixture.q.enqueue({
        tenantId: __fixture.tenant,
        type: RUNBOOK,
        payload: { incidentId, requestedBy: 'user-1', requestedMessageId: 'message-1' },
      });

      expect(requestId).toBe(automaticId);
      expect(await payloadOf(automaticId)).toEqual({
        incidentId,
        requestedBy: 'user-1',
        requestedMessageId: 'message-1',
      });
    },
  );

  test('an automatic enqueue never re-marks a pending request as automatic', async () => {
    const incidentId = await incident();
    const requestId = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: RUNBOOK,
      payload: { incidentId, requestedBy: 'user-1' },
    });
    await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: RUNBOOK,
      payload: { incidentId, automatic: true },
    });
    expect(await payloadOf(requestId)).toEqual({ incidentId, requestedBy: 'user-1' });
  });

  test('a terminal automatic pass is left alone and the request gets its own job', async () => {
    const incidentId = await incident();
    const automaticId = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: RUNBOOK,
      payload: { incidentId, automatic: true },
    });
    await __fixture.db.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, automaticId));
    const requestId = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: RUNBOOK,
      payload: { incidentId, requestedBy: 'user-1' },
    });
    expect(requestId).not.toBe(automaticId);
    expect(await payloadOf(automaticId)).toEqual({ incidentId, automatic: true });
    const pending = await __fixture.db.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.type, RUNBOOK), sql`payload->>'incidentId' = ${incidentId}`));
    expect(pending).toHaveLength(2);
  });

  test('a second request coalesces onto a pending request, which answers both', async () => {
    const incidentId = await incident();
    const firstId = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: RUNBOOK,
      payload: { incidentId, requestedBy: 'user-1' },
    });
    const secondId = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: RUNBOOK,
      payload: { incidentId, requestedBy: 'user-2' },
    });
    expect(secondId).toBe(firstId);
  });

  test('a request onto a pass that already chose silence is refused for retry', async () => {
    const incidentId = await incident();
    const automaticId = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: RUNBOOK,
      payload: { incidentId, automatic: true },
    });
    await __fixture.db.db
      .update(jobs)
      .set({ status: 'processing', payload: { incidentId, automatic: true, silenced: true } })
      .where(eq(jobs.id, automaticId));
    await expect(
      __fixture.q.enqueue({
        tenantId: __fixture.tenant,
        type: RUNBOOK,
        payload: { incidentId, requestedBy: 'user-1', requestedMessageId: 'message-1' },
      }),
    ).rejects.toBeInstanceOf(AutomaticPassFinishingError);
    expect(await payloadOf(automaticId)).toEqual({ incidentId, automatic: true, silenced: true });
  });
});
