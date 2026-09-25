import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  getIncident,
  jobs,
  incidents,
  recordIncidentRelation,
} from '@sre/db';
import { createFixture } from './incidents.fixture';
const fixture = createFixture();
const request = (incidentId: string, token: string, body: unknown) =>
  fixture.api.request(`/incidents/${incidentId}/resolution-policy`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const valid = () => ({
  policy: 'provider_clear',
  reason: 'This monitor is the agreed operational resolution criterion.',
  requestId: randomUUID(),
  expectedVersion: 0,
});
async function open(purpose: 'incident' | 'health_check' = 'incident') {
  return createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: randomUUID(),
    alertSource: 'manual',
    service: 'checkout',
    severity: 'sev3',
    purpose,
  });
}

test('an active member changes policy once with an audited reason, version check and recovery reevaluation', async () => {
  const incident = await open();
  const token = await fixture.sign(fixture.orgC);
  const clear = {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C_POLICY',
    externalMessageId: randomUUID(),
    state: 'resolved' as const,
    summary: 'Provider monitor recovered',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: new Date(),
    clearProvenance: 'provider' as const,
  };
  await applySignalObservation(fixture.app.db, fixture.tenantC, clear);
  const body = valid();
  expect((await request(incident.id, token, body)).status).toBe(200);
  expect((await request(incident.id, token, body)).status).toBe(200);
  expect(await getIncident(fixture.app.db, fixture.tenantC, incident.id)).toMatchObject({
    resolutionPolicy: 'provider_clear',
    lifecycleVersion: 1,
  });
  const history = await fixture.hub.history(fixture.tenantC, incident.id);
  expect(history.filter((message) => message.content.includes(body.reason))).toHaveLength(1);
  const stale = await request(incident.id, token, { ...valid(), policy: 'verified_recovery' });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: 'stale' });
  const queued = await fixture.admin.db
    .select()
    .from(jobs)
    .where(
      sql`tenant_id = ${fixture.tenantC} and type = 'recovery.verify' and payload->>'incidentId' = ${incident.id}`,
    );
  expect(queued).toHaveLength(1);
});

test.each([{ reason: '' }, { requestId: null }, { expectedVersion: -1 }, { policy: 'anything' }])(
  'policy commands reject invalid input: %o',
  async (invalid) => {
    const incident = await open();
    expect(
      (await request(incident.id, await fixture.sign(fixture.orgC), { ...valid(), ...invalid }))
        .status,
    ).toBe(400);
  },
);

test('policy commands preserve tenant isolation and reject provider-clear health checks', async () => {
  const incident = await open();
  expect((await request(incident.id, await fixture.sign(fixture.orgB), valid())).status).toBe(404);
  const healthCheck = await open('health_check');
  const rejected = await request(healthCheck.id, await fixture.sign(fixture.orgC), valid());
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({ error: 'invalid' });
});

test('policy commands reject archived, merged and terminal incidents and missing authentication', async () => {
  const token = await fixture.sign(fixture.orgC);
  const archived = await open();
  await fixture.admin.db
    .update(incidents)
    .set({ archivedAt: new Date() })
    .where(eq(incidents.id, archived.id));
  expect((await request(archived.id, token, valid())).status).toBe(404);
  const merged = await open();
  const target = await open();
  await recordIncidentRelation(fixture.app.db, fixture.tenantC, {
    sourceIncidentId: merged.id,
    targetIncidentId: target.id,
    type: 'merged_into',
    rationale: 'Same occurrence',
    evidence: ['human:observed'],
    decidedBy: 'human',
  });
  const mergedResponse = await request(merged.id, token, valid());
  expect(mergedResponse.status).toBe(409);
  expect(await mergedResponse.json()).toEqual({ error: 'merged' });
  const terminal = await open();
  await fixture.hub.transitionIncident(fixture.tenantC, terminal.id, {
    to: 'closed',
    reason: 'Completed review',
    transitionKey: randomUUID(),
    author: 'system',
  });
  const terminalResponse = await request(terminal.id, token, { ...valid(), expectedVersion: 1 });
  expect(terminalResponse.status).toBe(409);
  expect(await terminalResponse.json()).toEqual({ error: 'invalid' });
  expect(
    (await fixture.api.request(`/incidents/${target.id}/resolution-policy`, { method: 'POST' }))
      .status,
  ).toBe(401);
});
