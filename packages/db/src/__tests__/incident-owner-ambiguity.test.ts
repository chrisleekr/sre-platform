import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import {
  applySignalObservation,
  createIncident,
  getIncidentOwnerContext,
  entityServiceMappings,
  listIncidents,
  memberships,
  services,
  upsertEntityServiceMapping,
  users,
} from '../index';
import { createFixture } from './incident-repo.fixture';

const fixture = createFixture();
test('distinct legitimate provider keys retain every team without becoming an identity conflict', async () => {
  const tenantId = fixture.tenantB;
  const names = [randomUUID(), randomUUID()];
  await fixture.admin.db.insert(services).values([
    { tenantId, name: names[0]!, team: 'Alpha, Operations' },
    { tenantId, name: names[1]!, team: 'Zulu' },
  ]);
  const fingerprint = randomUUID();
  const incident = await createIncident(fixture.app.db, tenantId, {
    fingerprint,
    alertSource: 'test',
    service: 'unregistered',
    severity: 'sev2',
  });
  const now = new Date();
  await applySignalObservation(fixture.app.db, tenantId, {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C-DISTINCT',
    externalMessageId: randomUUID(),
    state: 'firing',
    summary: 'Two affected services.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: now,
    affectedEntities: names.map((name) => ({
      key: `service:${name}`,
      kind: 'service' as const,
      stableId: name,
      displayName: name,
      scope: {},
      provenance: { kind: 'provider_label' as const, source: 'service' },
      confidence: 95,
      observedAt: now.toISOString(),
      completeness: 'complete' as const,
      requiredCapabilities: ['metrics'],
    })),
  });
  const context = await getIncidentOwnerContext(fixture.app.db, tenantId, incident.id);
  expect(context).toEqual({
    fingerprint,
    teams: ['Alpha, Operations', 'Zulu'],
  });
  expect(
    (await listIncidents(fixture.app.db, tenantId)).find((row) => row.id === incident.id)
      ?.responsibleOwner,
  ).toBe('Alpha, Operations, Zulu');
});

test('conflicting identities for one candidate key stay unowned until a human mapping resolves the key', async () => {
  const tenantId = fixture.tenantA;
  const userId = randomUUID();
  const names = [randomUUID(), randomUUID(), randomUUID()];
  const key = `service:${randomUUID()}`;
  await fixture.admin.db
    .insert(users)
    .values({ id: userId, issuer: 'test', subject: randomUUID(), email: 'owner@example.test' });
  await fixture.admin.db.insert(memberships).values({ tenantId, userId });
  await fixture.admin.db
    .insert(services)
    .values(
      names.map((name, index) => ({ tenantId, name, team: ['Legacy', 'First', 'Second'][index]! })),
    );
  const incident = await createIncident(fixture.app.db, tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'test',
    service: names[0]!,
    severity: 'sev2',
  });
  try {
    for (const name of names.slice(1)) {
      const now = new Date();
      await applySignalObservation(fixture.app.db, tenantId, {
        incidentId: incident.id,
        surface: 'slack',
        channel: 'C-CONFLICT',
        externalMessageId: randomUUID(),
        state: 'firing',
        summary: 'Provider identity observation.',
        contentHash: randomUUID(),
        eventKey: randomUUID(),
        eventAt: now,
        affectedEntities: [
          {
            key,
            kind: 'service',
            stableId: name,
            displayName: name,
            scope: {},
            provenance: { kind: 'provider_label', source: 'service' },
            confidence: 95,
            observedAt: now.toISOString(),
            completeness: 'complete',
            requiredCapabilities: ['metrics'],
          },
        ],
      });
    }
    expect
      .soft(
        (await listIncidents(fixture.app.db, tenantId)).find((row) => row.id === incident.id)
          ?.responsibleOwner,
      )
      .toBeNull();
    expect(await getIncidentOwnerContext(fixture.app.db, tenantId, incident.id)).toMatchObject({
      teams: [],
    });
    expect(
      await getIncidentOwnerContext(fixture.admin.db, fixture.tenantB, incident.id),
    ).toBeNull();
    await upsertEntityServiceMapping(fixture.app.db, tenantId, {
      candidateKey: key,
      candidateKind: 'service',
      serviceName: names[2]!,
      confirmedByUserId: userId,
      rationale: 'Confirmed this key belongs to the second service.',
    });
    expect(
      (await listIncidents(fixture.app.db, tenantId)).find((row) => row.id === incident.id)
        ?.responsibleOwner,
    ).toBe('Second');
    expect(await getIncidentOwnerContext(fixture.app.db, tenantId, incident.id)).toMatchObject({
      teams: ['Second'],
    });
  } finally {
    await fixture.admin.db
      .delete(entityServiceMappings)
      .where(eq(entityServiceMappings.tenantId, tenantId));
    await fixture.admin.db.delete(memberships).where(eq(memberships.userId, userId));
    await fixture.admin.db.delete(users).where(eq(users.id, userId));
  }
});
