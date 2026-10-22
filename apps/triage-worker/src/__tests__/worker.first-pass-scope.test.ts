import { randomUUID } from 'node:crypto';

import { alertmanagerAffectedEntities } from '@sre/alerts/src/provider-lifecycle/normalize';
import type { IDataSourceConnector } from '@sre/connectors';
import { createIncident, incidentSignals } from '@sre/db';
import { describe, expect, test, vi } from 'vitest';

import type { TriageEngine } from '../engine/types';
import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('first-pass scope', () => {
  test('an alert-labelled namespace scopes the read when no topology subject resolves', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'unclassified',
      severity: 'sev3',
    });
    await __fixture.admin.db.insert(incidentSignals).values({
      tenantId: __fixture.tenantId,
      incidentId: id,
      surface: 'alertmanager',
      channel: 'prometheus',
      externalMessageId: id,
      state: 'firing',
      lastEventType: 'opened',
      summary: 'Job gitlab/backup-1 failed to complete.',
      contentHash: id,
      lastEventKey: id,
      lastEventAt: new Date(),
      affectedEntities: alertmanagerAffectedEntities(
        { labels: { alertname: 'KubeJobFailed', namespace: 'gitlab', node: '192.168.1.202' } },
        new Date(),
      ),
    });
    const kubernetesFetch = vi.fn(async () => ({ source: 'kubernetes' as const, data: {} }));
    const kubernetes: IDataSourceConnector = {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Test kubernetes',
      type: 'kubernetes',
      snapshot: async () => [],
      fetchTriageContext: kubernetesFetch,
      tools: () => [],
      probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
    };
    const engine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      investigate: async (input) => ({
        provider: 'fake',
        sessionId: `fake:${input.incident.id}`,
        model: 'fake',
        outcome: 'conclusive',
        turnBudget: 1,
        summary: 'scoped evidence captured',
        confidence: 70,
      }),
      resume: async () => {
        throw new Error('resume is not used');
      },
    };
    const worker = __fixture.workerWithEngine(engine, {
      connectorProvider: () => async () => [kubernetes],
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: id },
    });
    expect(await worker.tick('labelled-scope')).toBe(1);
    expect(kubernetesFetch).toHaveBeenCalledWith({
      service: 'unclassified',
      windowMinutes: 60,
      scope: { namespaces: ['gitlab'], nodes: ['192.168.1.202'] },
    });
  });
});
