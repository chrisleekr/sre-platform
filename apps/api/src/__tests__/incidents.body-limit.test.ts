import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('incident feedback command body limits', () => {
  test('rejects oversized entity and relationship bodies before parsing', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const auth = __fixture.auth(token);
    const incidentId = randomUUID();
    const request = (path: string, body: string) =>
      __fixture.api.request(`/incidents/${incidentId}/${path}`, {
        ...auth,
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body,
      });

    const entity = await request(
      'entity-mapping',
      JSON.stringify({
        candidateKey: 'x'.repeat(17 * 1024),
        serviceName: 'checkout',
        rationale: 'Known ownership.',
      }),
    );
    expect(entity.status).toBe(413);
    await expect(entity.json()).resolves.toEqual({ error: 'payload too large' });

    for (const action of ['merge', 'split', 'unrelated']) {
      const relationship = await request(
        action,
        JSON.stringify({
          targetIncidentId: randomUUID(),
          rationale: 'x'.repeat(65 * 1024),
          evidence: ['same signal'],
        }),
      );
      expect(relationship.status).toBe(413);
      await expect(relationship.json()).resolves.toEqual({ error: 'payload too large' });
    }
  });
});
