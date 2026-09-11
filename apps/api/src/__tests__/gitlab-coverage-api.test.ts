import { expect, test } from 'vitest';
import { gitlabProjects, withTenant } from '@sre/db';
import { createFixture } from './connectors.fixture';

const fixture = createFixture();

test('returns bounded tenant-isolated project polling evidence through the connector API', async () => {
  const api = fixture.makeConnApp();
  const headers = fixture.bearer(await fixture.sign(fixture.orgA));
  const save = await api.request('/connectors/gitlab', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      settings: {
        baseUrl: 'https://gitlab.example.com',
        groupId: 7,
        groupPath: 'platform',
        eventStrategy: 'system',
        eventTransport: 'none',
      },
      credential: 'test-only-read-token',
    }),
  });
  expect(save.status).toBe(200);
  const { connectorId } = (await save.json()) as { connectorId: string };
  await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx.insert(gitlabProjects).values([
      {
        tenantId: fixture.tenantA,
        connectorId,
        groupId: '7',
        projectId: '41',
        name: 'waiting',
        fullPath: 'platform/waiting',
        webUrl: 'https://gitlab.example.com/platform/waiting',
      },
      {
        tenantId: fixture.tenantA,
        connectorId,
        groupId: '7',
        projectId: '42',
        name: 'failed',
        fullPath: 'platform/failed',
        webUrl: 'https://gitlab.example.com/platform/failed',
        pollFailureCategory: 'permission_denied',
        pollSucceededAt: new Date('2026-09-08T00:00:00Z'),
        pollCursor: { pipeline: { pending: true, activeOverflow: true } },
      },
    ]),
  );
  const response = await api.request('/connectors', { headers });
  expect(response.status).toBe(200);
  const { connectors } = (await response.json()) as {
    connectors: Array<{
      id: string;
      polling: { gitlabCoverage: unknown };
      events: { count: number };
    }>;
  };
  const connector = connectors.find((c) => c.id === connectorId)!;
  expect(connector.polling.gitlabCoverage).toMatchObject({
    total: 2,
    notChecked: 1,
    failed: 1,
    backlog: 1,
    trackingLimited: 1,
    projects: [
      { project: 'platform/failed', failureCategory: 'permission_denied', trackingLimited: true },
      { project: 'platform/waiting', lastSuccessAt: null, trackingLimited: false },
    ],
  });
  expect(connector.events.count).toBe(0);
  expect(JSON.stringify(connectors)).not.toContain('test-only-read-token');
  const other = await api.request('/connectors', {
    headers: fixture.bearer(await fixture.sign(fixture.orgB)),
  });
  expect(await other.text()).not.toContain('platform/');
});
