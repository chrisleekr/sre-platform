import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createIncident, incidentMessages, withTenant } from '@sre/db';
import { createFixture } from './incidents.fixture';

const fixture = createFixture();
test('list, detail and workspace agree on an opening-context description under authenticated tenant scope', async () => {
  const created = await createIncident(fixture.app.db, fixture.tenantA, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'slack:channel',
    severity: 'sev3',
    title: '<@U123>',
  });
  const at = new Date();
  const origin = `slack:title:${created.id}`;
  await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx.insert(incidentMessages).values([
      {
        tenantId: fixture.tenantA,
        incidentId: created.id,
        author: 'human',
        kind: 'text',
        content: '<@U123> Check cluster health?',
        originMessageId: origin,
        createdAt: at,
      },
      {
        tenantId: fixture.tenantA,
        incidentId: created.id,
        author: 'system',
        kind: 'lifecycle',
        content: 'Incident opened',
        lifecycleVersion: 0,
        createdAt: at,
      },
    ]),
  );
  const auth = fixture.auth(await fixture.sign(fixture.orgA));
  const listResponse = await fixture.api.request('/incidents?state=all', auth);
  expect(listResponse.status).toBe(200);
  const list = (await listResponse.json()) as {
    incidents: Array<{ id: string; displayTitle: string; titleSource: string }>;
  };
  expect(list.incidents.find((row) => row.id === created.id)).toMatchObject({
    displayTitle: 'Check cluster health?',
    titleSource: 'opening_request',
  });
  for (const path of [`/incidents/${created.id}`, `/incidents/${created.id}/workspace`]) {
    const result = await fixture.api.request(path, auth);
    expect(result.status).toBe(200);
    const body = (await result.json()) as Record<string, unknown>;
    expect(body.incident ?? body).toMatchObject({
      title: '<@U123>',
      displayTitle: 'Check cluster health?',
      titleSource: 'opening_request',
    });
    const denied = await fixture.api.request(path, fixture.auth(await fixture.sign(fixture.orgB)));
    expect(denied.status).toBe(404);
  }
});
