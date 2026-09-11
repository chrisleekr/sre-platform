import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  incidentFeedback,
  incidentSignals,
  incidents,
  withTenant,
} from '@sre/db';
import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('incident feedback correction races', () => {
  test('rejects stale noise feedback after its signal moves to another incident', async () => {
    const source = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `feedback-race-source-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const target = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `feedback-race-target-${randomUUID()}`,
      alertSource: 'slack',
      service: 'payments',
      severity: 'sev2',
    });
    const observed = await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      incidentId: source.id,
      surface: 'slack',
      channel: 'C-FEEDBACK-RACE',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Checkout alert firing.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    let releaseMove!: () => void;
    let incidentLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      incidentLocked = resolve;
    });
    let moveBackendPid: number | undefined;
    const move = withTenant(__fixture.app.db, __fixture.tenantC, async (tx) => {
      const backend = await tx.execute(sql`select pg_backend_pid()::int as pid`);
      moveBackendPid = Number((backend as unknown as Array<{ pid: number }>)[0]!.pid);
      await tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.id, source.id))
        .for('update');
      incidentLocked();
      await release;
      await tx
        .select({ id: incidentSignals.id })
        .from(incidentSignals)
        .where(eq(incidentSignals.id, observed.signal.id))
        .for('update');
      await tx
        .update(incidentSignals)
        .set({ incidentId: target.id })
        .where(eq(incidentSignals.id, observed.signal.id));
    });
    await locked;
    const token = await __fixture.sign(__fixture.orgC);
    const auth = __fixture.auth(token);
    const responsePromise = Promise.resolve(
      __fixture.api.request(`/incidents/${source.id}/feedback`, {
        ...auth,
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          targetType: 'noise',
          targetId: observed.signal.id,
          decision: 'noise',
          rationale: 'The responder classified this provider signal as noise.',
          replacement: null,
        }),
      }),
    );
    let requestSettled = false;
    void responsePromise.then(
      () => {
        requestSettled = true;
      },
      () => {
        requestSettled = true;
      },
    );
    let waitFailure: unknown;
    try {
      await expect
        .poll(async () => {
          const blocked = await __fixture.admin.sql<Array<{ pid: number }>>`
            SELECT pid
            FROM pg_stat_activity
            WHERE ${moveBackendPid!} = ANY(pg_blocking_pids(pid))
          `;
          return blocked.map((row) => row.pid);
        })
        .not.toEqual([]);
      expect(requestSettled).toBe(false);
    } catch (error) {
      waitFailure = error;
    } finally {
      releaseMove();
      await move;
    }
    const response = await responsePromise;
    if (waitFailure) throw waitFailure;
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'feedback target not found' });
    expect(
      await __fixture.admin.db
        .select({ id: incidentFeedback.id })
        .from(incidentFeedback)
        .where(
          and(
            eq(incidentFeedback.targetType, 'noise'),
            eq(incidentFeedback.targetId, observed.signal.id),
          ),
        ),
    ).toEqual([]);
  });
});
