import { randomUUID } from 'node:crypto';
import { createIncident } from '@sre/db';
import type { IDataSourceConnector } from '@sre/connectors';
import { beforeEach, expect, test } from 'vitest';
import { makeFakeEngine } from '../engine/fake';
import { resetPlatformIdentityCache } from '../worker/platform-identity';
import { createFixture } from './worker.fixture';

const fixture = createFixture();

beforeEach(() => resetPlatformIdentityCache());

test('an investigation is told which provider logins are the platform itself', async () => {
  const incident = await createIncident(fixture.app.db, fixture.tenantId, {
    fingerprint: randomUUID(),
    service: 'grafana',
    alertSource: 'manual',
    severity: 'sev3',
  });
  const grafana = {
    id: randomUUID(),
    name: 'Homelab Grafana',
    type: 'grafana',
    tools: () => [],
    identity: async () => 'sa-1-homelab',
  } as unknown as IDataSourceConnector;
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
        summary: 'Assessed.',
        confidence: 70,
      };
    },
  };
  await fixture.workerWithEngine(engine, { connectorProvider: () => async () => [grafana] }).handle(
    {
      id: randomUUID(),
      tenantId: fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: { incidentId: incident.id },
    },
    { signal: new AbortController().signal },
  );
  expect(context).toContain("this platform's own requests");
  expect(context).toContain('grafana connection "Homelab Grafana" authenticates as sa-1-homelab');
});
