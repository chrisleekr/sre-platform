import { describe, expect, test } from 'vitest';
import { createFixture } from './incidents.fixture';

// start state. createFixture registers its own afterAll cleanup
// (registerIncidentFixtureCleanup), so nothing here outlives the file. RED now: neither route is
// registered, so Hono answers 404 for both.
const __fixture = createFixture();

describe('postmortem and RCA calibration routes', () => {
  test('POST /incidents/:id/postmortem/generate enqueues a generation and returns 202', async () => {
    const auth = __fixture.auth(await __fixture.sign(__fixture.orgC));
    const res = await __fixture.api.request(
      `/incidents/${__fixture.runbookIncidentId}/postmortem/generate`,
      {
        ...auth,
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ trigger: 'slow_resolution' }),
      },
    );
    expect(res.status).toBe(202);
  });

  test('GET /reliability/rca-calibration returns the calibration report', async () => {
    const res = await __fixture.api.request(
      '/reliability/rca-calibration',
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(res.status).toBe(200);
  });
});
