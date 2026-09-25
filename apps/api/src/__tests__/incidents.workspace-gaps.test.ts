import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createIncident, investigationRuns } from '@sre/db';
import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

test('the workspace exposes the latest run reviewer gaps as bounded scrubbed strings', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `run-gaps-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'grafana',
    severity: 'sev3',
  });
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const runId = randomUUID();
  await __fixture.admin.db.insert(investigationRuns).values({
    id: runId,
    tenantId: __fixture.tenantC,
    incidentId: incident.id,
    operation: 'investigate',
    outcome: 'inconclusive',
    result: {
      summary: 'Grafana was OOMKilled at 09:12Z.',
      nextStep: 'Query container RSS against the limit.',
      gaps: [
        'Confirm the termination reason per restart.',
        42,
        '   ',
        // A cut before scrubbing would leave a partial key the pattern no longer recognizes.
        `${'x'.repeat(230)} ${secret}`,
        'Third.',
        'Fourth.',
        'Fifth.',
        'Sixth is dropped.',
      ],
    },
    completedAt: new Date(),
  });
  const token = await __fixture.sign(__fixture.orgC);
  const response = await __fixture.api.request(
    `/incidents/${incident.id}/workspace`,
    __fixture.auth(token),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    incident: { latestInvestigationRun: { id: string; nextStep: string; gaps: string[] } };
  };
  const run = body.incident.latestInvestigationRun;
  expect(run).toMatchObject({ id: runId, nextStep: 'Query container RSS against the limit.' });
  expect(run.gaps).toHaveLength(5);
  expect(run.gaps[0]).toBe('Confirm the termination reason per restart.');
  expect(run.gaps.join(' ')).not.toContain(secret.slice(0, 8));
  expect(run.gaps[1]).toHaveLength(240);
  expect(run.gaps).not.toContain('Sixth is dropped.');
  const detail = await __fixture.api.request(`/incidents/${incident.id}`, __fixture.auth(token));
  const detailBody = (await detail.json()) as { latestInvestigationRun: { gaps: string[] } };
  expect(detailBody.latestInvestigationRun.gaps).toEqual(run.gaps);
});

test('a run without stored gaps exposes an empty list', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `run-no-gaps-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'grafana',
    severity: 'sev3',
  });
  await __fixture.admin.db.insert(investigationRuns).values({
    id: randomUUID(),
    tenantId: __fixture.tenantC,
    incidentId: incident.id,
    operation: 'investigate',
    outcome: 'conclusive',
    result: { summary: 'Recovered.' },
    completedAt: new Date(),
  });
  const token = await __fixture.sign(__fixture.orgC);
  const response = await __fixture.api.request(
    `/incidents/${incident.id}/workspace`,
    __fixture.auth(token),
  );
  const body = (await response.json()) as {
    incident: { latestInvestigationRun: { gaps: string[] } };
  };
  expect(body.incident.latestInvestigationRun.gaps).toEqual([]);
});
