import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  serializeSignalFence,
} from '@sre/db';

import { type TriageEngine } from '../engine/types';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('signal-driven recovery and explicit lifecycle commands', () => {
  const signal = (
    id: string,
    over: Partial<Parameters<typeof applySignalObservation>[2]> = {},
  ) => ({
    incidentId: id,
    surface: 'slack',
    channel: 'C-lifecycle',
    externalMessageId: `signal-${id}`,
    state: 'firing' as const,
    summary: 'Checkout errors are firing',
    contentHash: 'firing-hash',
    eventKey: `firing-${id}`,
    eventAt: new Date('2026-08-21T02:00:00.000Z'),
    ...over,
  });

  test('a terminal lifecycle change during recovery drops the stale proposal and restores progress', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-lifecycle-race-${randomUUID()}`,
      alertSource: 'slack',
      service: 'payments',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'The payment queue was saturated.',
      confidence: 70,
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: 'lifecycle-race-clear',
      eventKey: `lifecycle-race-clear:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery(input) {
        await __fixture.hub.transitionIncident(__fixture.tenantId, id, {
          to: 'resolved',
          reason: 'Responder resolved the incident during verification.',
          transitionKey: `lifecycle-race:${id}`,
          author: 'human',
          authorUserId: __fixture.actorUserId,
          expectedVersion: 0,
        });
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'The first health read looked normal.',
          confidence: 0,
          recovery: {
            recovered: true,
            evidence: [__fixture.recoveryCheck('One current health read passed.')],
            unknowns: [],
            nextStep: null,
          },
        };
      },
    };

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'recovery.verify',
        attempts: 1,
        payload: {
          incidentId: id,
          lifecycleVersion: 0,
          signalFence: serializeSignalFence([cleared.signal]),
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 1,
      investigationStatus: 'assessed',
    });
    const history = await __fixture.hub.history(__fixture.tenantId, id);
    expect(history.filter((message) => message.kind === 'lifecycle')).toHaveLength(1);
    expect(history.some((message) => message.content.startsWith('RECOVERED'))).toBe(false);
  });

  test('an engine failure after terminal lifecycle change restores recovery progress', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-terminal-error-${randomUUID()}`,
      alertSource: 'slack',
      service: 'payments',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'The payment queue was saturated.',
      confidence: 70,
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: 'terminal-error-clear',
      eventKey: `terminal-error-clear:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery() {
        await __fixture.hub.transitionIncident(__fixture.tenantId, id, {
          to: 'resolved',
          reason: 'Responder verified service health during recovery.',
          transitionKey: `terminal-error:${id}`,
          author: 'human',
          authorUserId: __fixture.actorUserId,
          expectedVersion: 0,
        });
        throw new Error('provider failed after lifecycle changed');
      },
    };

    await expect(
      __fixture.workerWithEngine(engine).handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'recovery.verify',
          attempts: 1,
          payload: {
            incidentId: id,
            lifecycleVersion: 0,
            signalFence: serializeSignalFence([cleared.signal]),
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('provider failed after lifecycle changed');

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 1,
      investigationStatus: 'assessed',
    });
  });

  test('an explicit human command becomes one audited transition and does not rewrite the RCA', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `verbal-${randomUUID()}`,
      alertSource: 'slack',
      service: 'api',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'The API deployment introduced a retry storm.',
      confidence: 75,
    });
    const command = await __fixture.hub.append(__fixture.tenantId, id, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'Resolve this incident, service health is back to normal.',
      originSurface: 'slack',
      originMessageId: `slack:C-lifecycle:${randomUUID()}`,
    });
    const resume = vi.fn(async () => {
      throw new Error('explicit lifecycle commands must bypass the model');
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      resume,
      verifyRecovery: __fixture.verifyRecovery,
    };

    const lifecycleWorker = __fixture.workerWithEngine(engine);
    const job = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'resume',
      attempts: 1,
      payload: { incidentId: id, humanMessageId: command.id },
    };
    await lifecycleWorker.handle(job, { signal: new AbortController().signal });
    await lifecycleWorker.handle(job, { signal: new AbortController().signal });

    const incident = await getIncident(__fixture.app.db, __fixture.tenantId, id);
    expect(incident).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 1,
      rcaSummary: 'The API deployment introduced a retry storm.',
      lastResumeMessageId: command.id,
    });
    const audit = (await __fixture.hub.history(__fixture.tenantId, id)).filter(
      (message) => message.kind === 'lifecycle',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      author: 'human',
      authorUserId: __fixture.actorUserId,
      originSurface: 'slack',
      lifecycleFrom: 'open',
      lifecycleTo: 'resolved',
      transitionKey: `verbal:${id}:${command.id}`,
    });
    expect(resume).not.toHaveBeenCalled();
  });
});
