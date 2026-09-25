import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  getIncident,
  incidentFeedback,
  incidentServiceAssignments,
  incidentSignals,
  memberships,
  services,
  upsertEntityServiceMapping,
} from '@sre/db';
import { createFixture } from './incidents.fixture';

const fixture = createFixture();
let token: string;
let originalRole: 'owner' | 'admin' | 'member';
const actorScope = () =>
  and(eq(memberships.tenantId, fixture.tenantC), eq(memberships.userId, fixture.tenantCUserId));
beforeEach(async () => {
  const [actor] = await fixture.admin.db.select().from(memberships).where(actorScope());
  originalRole = actor!.role;
  await fixture.admin.db.update(memberships).set({ role: 'admin' }).where(actorScope());
  token = await fixture.sign(fixture.orgC);
});
afterEach(async () => {
  await fixture.admin.db
    .delete(incidentServiceAssignments)
    .where(eq(incidentServiceAssignments.tenantId, fixture.tenantC));
  await fixture.admin.db.update(memberships).set({ role: originalRole }).where(actorScope());
});

const assign = (id: string, names: string[], bearer = token) =>
  fixture.api.request(`/topology/incidents/${id}/services`, {
    method: 'PUT',
    headers: { ...fixture.auth(bearer).headers, 'content-type': 'application/json' },
    body: JSON.stringify({ services: names, rationale: 'Confirmed affected service ownership.' }),
  });
const addIncident = async (service: string) =>
  createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: randomUUID(),
    alertSource: 'alertmanager',
    service,
    severity: 'sev2',
  });
const observe = async (id: string, service: string, key = `provider:service:${randomUUID()}`) => {
  const observedAt = new Date();
  return applySignalObservation(fixture.app.db, fixture.tenantC, {
    incidentId: id,
    surface: 'slack',
    channel: 'C-OWNER-PARITY',
    externalMessageId: randomUUID(),
    state: 'firing',
    summary: 'Original provider service is unhealthy.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: observedAt,
    affectedEntities: [
      {
        key,
        kind: 'service',
        stableId: service,
        displayName: service,
        scope: {},
        provenance: { kind: 'provider_label', source: 'service' },
        confidence: 95,
        observedAt: observedAt.toISOString(),
        completeness: 'complete',
        requiredCapabilities: ['metrics'],
      },
    ],
  });
};
const assertOwners = async (id: string, expected: string[]) => {
  const queue = await fixture.api.request('/incidents?state=open', fixture.auth(token));
  expect(queue.status).toBe(200);
  const body = (await queue.json()) as {
    incidents: { id: string; responsibleOwner: string | null }[];
  };
  const detail = await fixture.api.request(`/incidents/${id}/workspace`, fixture.auth(token));
  expect(detail.status).toBe(200);
  const workspace = (await detail.json()) as {
    serviceTeams: string[];
    attention: { owner: string | null };
  };
  expect
    .soft(body.incidents.find((row) => row.id === id)?.responsibleOwner)
    .toBe(expected.length ? expected.join(', ') : null);
  expect.soft(workspace.serviceTeams).toEqual(expected);
  expect.soft(workspace.attention.owner).toBe(expected.length ? expected.join(', ') : null);
};

test('authorized service assignment overrides provider ownership on both surfaces and updates without historical mutation', async () => {
  const legacy = `legacy-${randomUUID()}`;
  const assigned = `assigned-${randomUUID()}`;
  await fixture.admin.db.insert(services).values([
    { tenantId: fixture.tenantC, name: legacy, team: 'Team A' },
    { tenantId: fixture.tenantC, name: assigned, team: 'Team B' },
  ]);
  const { id } = await addIncident(legacy);
  await observe(id, legacy);
  const before = await getIncident(fixture.app.db, fixture.tenantC, id);
  const signalsBefore = await fixture.admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.incidentId, id));
  expect((await assign(id, [assigned])).status).toBe(200);
  await assertOwners(id, ['Team B']);
  await fixture.admin.db
    .update(services)
    .set({ team: 'Team B renamed' })
    .where(and(eq(services.tenantId, fixture.tenantC), eq(services.name, assigned)));
  await assertOwners(id, ['Team B renamed']);
  expect((await assign(id, [])).status).toBe(200);
  await assertOwners(id, ['Team A']);
  expect(
    await fixture.admin.db.select().from(incidentSignals).where(eq(incidentSignals.incidentId, id)),
  ).toEqual(signalsBefore);
  const after = await getIncident(fixture.app.db, fixture.tenantC, id);
  expect(after).toMatchObject({
    status: before!.status,
    lifecycleVersion: before!.lifecycleVersion,
    rcaSummary: before!.rcaSummary,
  });
  const feedback = await fixture.admin.db
    .select()
    .from(incidentFeedback)
    .where(eq(incidentFeedback.incidentId, id));
  expect(feedback).toHaveLength(2);
  expect(
    feedback.every(
      (item) => item.createdByUserId === fixture.tenantCUserId && item.targetType === 'entity',
    ),
  ).toBe(true);
});

test.each(['candidate-less', 'teamless', 'multiple teams'] as const)(
  'explicit %s services have identical queue and detail ownership',
  async (scenario) => {
    const legacy = `legacy-${randomUUID()}`;
    const names = [randomUUID(), randomUUID(), randomUUID()];
    await fixture.admin.db.insert(services).values([
      { tenantId: fixture.tenantC, name: legacy, team: 'Unrelated legacy team' },
      ...names.map((name, index) => ({
        tenantId: fixture.tenantC,
        name,
        team: scenario === 'teamless' ? null : index === 1 ? 'Zulu' : 'Alpha, Operations',
      })),
    ]);
    const { id } = await addIncident(legacy);
    if (scenario !== 'candidate-less') await observe(id, legacy);
    expect((await assign(id, scenario === 'multiple teams' ? names : [names[0]!])).status).toBe(
      200,
    );
    await assertOwners(
      id,
      scenario === 'teamless'
        ? []
        : scenario === 'multiple teams'
          ? ['Alpha, Operations', 'Zulu']
          : ['Alpha, Operations'],
    );
  },
);

test('removing an explicit assignment restores human mapping then legacy only after resolved context is removed', async () => {
  const names = [randomUUID(), randomUUID(), randomUUID()];
  const key = `provider:service:${randomUUID()}`;
  await fixture.admin.db.insert(services).values(
    names.map((name, index) => ({
      tenantId: fixture.tenantC,
      name,
      team: ['Legacy', 'Mapped', 'Explicit'][index]!,
    })),
  );
  const { id } = await addIncident(names[0]!);
  await observe(id, names[0]!, key);
  await upsertEntityServiceMapping(fixture.app.db, fixture.tenantC, {
    candidateKey: key,
    candidateKind: 'service',
    serviceName: names[1]!,
    confirmedByUserId: fixture.tenantCUserId,
    rationale: 'Confirmed service mapping.',
  });
  expect((await assign(id, [names[2]!])).status).toBe(200);
  await assertOwners(id, ['Explicit']);
  expect((await assign(id, [])).status).toBe(200);
  await assertOwners(id, ['Mapped']);
  await fixture.admin.db
    .update(services)
    .set({ team: null })
    .where(and(eq(services.tenantId, fixture.tenantC), eq(services.name, names[1]!)));
  await assertOwners(id, []);
  await fixture.admin.db.delete(incidentSignals).where(eq(incidentSignals.incidentId, id));
  await assertOwners(id, ['Legacy']);
});

test('identical service names and candidate keys cannot import another tenant owner or authorize foreign assignment', async () => {
  const name = `shared-${randomUUID()}`;
  const key = `provider:service:${randomUUID()}`;
  await fixture.admin.db.insert(services).values([
    { tenantId: fixture.tenantC, name, team: 'Local owner' },
    { tenantId: fixture.tenantB, name, team: 'Foreign owner' },
  ]);
  const { id } = await addIncident(name);
  await observe(id, name, key);
  const [foreignActor] = await fixture.admin.db
    .select()
    .from(memberships)
    .where(eq(memberships.tenantId, fixture.tenantB));
  await upsertEntityServiceMapping(fixture.app.db, fixture.tenantB, {
    candidateKey: key,
    candidateKind: 'service',
    serviceName: name,
    confirmedByUserId: foreignActor!.userId,
    rationale: 'Foreign mapping with identical key.',
  });
  await fixture.admin.db
    .update(memberships)
    .set({ role: 'admin' })
    .where(
      and(eq(memberships.tenantId, fixture.tenantB), eq(memberships.userId, foreignActor!.userId)),
    );
  try {
    const foreignToken = await fixture.sign(fixture.orgB);
    expect(
      (await fixture.api.request(`/incidents/${id}/workspace`, fixture.auth(foreignToken))).status,
    ).toBe(404);
    expect((await assign(id, [name], foreignToken)).status).toBe(404);
    expect((await assign(id, [name])).status).toBe(200);
    await assertOwners(id, ['Local owner']);
    const response = await fixture.api.request('/incidents?state=open', fixture.auth(foreignToken));
    const body = (await response.json()) as { incidents: { id: string }[] };
    expect(body.incidents.some((item) => item.id === id)).toBe(false);
  } finally {
    await fixture.admin.db
      .update(memberships)
      .set({ role: foreignActor!.role })
      .where(
        and(
          eq(memberships.tenantId, fixture.tenantB),
          eq(memberships.userId, foreignActor!.userId),
        ),
      );
  }
});
