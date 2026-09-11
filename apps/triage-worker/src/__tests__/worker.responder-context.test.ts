import { randomUUID } from 'node:crypto';
import { createIncident, getIncident, incidentMessages } from '@sre/db';
import { expect, test } from 'vitest';
import { makeFakeEngine } from '../engine/fake';
import { createFixture } from './worker.fixture';

const fixture = createFixture();

test('chatty context uses the newest bounded snapshot and its actual latest watermark', async () => {
  const incident = await createIncident(fixture.app.db, fixture.tenantId, {
    fingerprint: randomUUID(),
    service: 'checkout',
    alertSource: 'manual',
    severity: 'sev3',
  });
  await fixture.admin.db.insert(incidentMessages).values(
    Array.from({ length: 503 }, (_, index) => ({
      tenantId: fixture.tenantId,
      incidentId: incident.id,
      author: 'human',
      kind: 'text',
      content: `responder-row-${index}-end`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + index),
    })),
  );
  let context = '';
  const engine = {
    ...makeFakeEngine(),
    investigate: async (input: import('../engine/types').TriageInput) => {
      context = input.context ?? '';
      return {
        provider: 'fake',
        sessionId: randomUUID(),
        disposition: 'rca' as const,
        outcome: 'conclusive' as const,
        turnBudget: 1,
        summary: 'Bounded context assessed.',
        confidence: 70,
      };
    },
  };
  await fixture.workerWithEngine(engine).handle(
    {
      id: randomUUID(),
      tenantId: fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: { incidentId: incident.id },
    },
    { signal: new AbortController().signal },
  );
  expect(context).not.toContain('responder-row-2-end');
  expect(context).toContain('responder-row-3-end');
  expect(context).toContain('responder-row-502-end');
  expect(context.match(/responder-row-\d+-end/g)).toHaveLength(500);
  expect((await getIncident(fixture.app.db, fixture.tenantId, incident.id))?.rcaSummary).toBe(
    'Bounded context assessed.',
  );
});

test.each([false, true])(
  'initial investigation consumes only its actual context snapshot, setup correction=%s',
  async (correction) => {
    const incident = await createIncident(fixture.app.db, fixture.tenantId, {
      fingerprint: randomUUID(),
      service: 'checkout',
      alertSource: 'manual',
      severity: 'sev3',
      purpose: 'health_check',
    });
    const currentMessage = 'Check general system health.';
    await fixture.hub.append(fixture.tenantId, incident.id, {
      author: 'human',
      authorUserId: fixture.actorUserId,
      content: currentMessage,
    });
    let supplied = '';
    let connectorLookups = 0;
    const engine = {
      ...makeFakeEngine(),
      investigate: async (input: import('../engine/types').TriageInput) => {
        supplied = JSON.stringify(input);
        return {
          provider: 'fake',
          sessionId: randomUUID(),
          disposition: 'rca' as const,
          outcome: 'conclusive' as const,
          turnBudget: 1,
          summary: 'Current checks found no failure.',
          confidence: 70,
        };
      },
    };
    const worker = fixture.workerWithEngine(engine, {
      connectorProvider: () => async () => {
        connectorLookups += 1;
        if (correction && connectorLookups === 2)
          await fixture.hub.append(fixture.tenantId, incident.id, {
            author: 'human',
            authorUserId: fixture.actorUserId,
            content: 'Correction: investigate billing, not checkout.',
          });
        return [];
      },
    });
    await worker.handle(
      {
        id: randomUUID(),
        tenantId: fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: incident.id, alert: { currentMessage } },
      },
      { signal: new AbortController().signal },
    );
    expect(supplied.split(currentMessage)).toHaveLength(2);
    const stored = await getIncident(fixture.app.db, fixture.tenantId, incident.id);
    if (correction) {
      expect(supplied).not.toContain('Correction:');
      expect(stored?.rcaSummary).not.toBe('Current checks found no failure.');
    } else expect(stored?.rcaSummary).toBe('Current checks found no failure.');
  },
);
