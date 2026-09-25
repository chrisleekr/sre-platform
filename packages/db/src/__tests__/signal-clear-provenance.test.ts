import type { SignalClearProvenance } from '@sre/contracts';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  applySignalObservation,
  correctIncidentSignalTx,
  createIncident,
  getIncident,
  incidentSignalFenceTx,
  withTenant,
} from '../index';
import { createFixture } from './incident-repo.fixture';
const fixture = createFixture();

async function open() {
  return createIncident(fixture.app.db, fixture.tenantA, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
  });
}
const observation = (
  incidentId: string,
  state: 'firing' | 'resolved',
  version: number,
  clearProvenance?: SignalClearProvenance,
) => ({
  incidentId,
  surface: 'slack',
  channel: 'C_TEST',
  externalMessageId: incidentId,
  state,
  summary: 'Checkout monitor state',
  contentHash: 'unchanged-summary',
  eventKey: `${incidentId}:${version}:producer:bot:B_TEST`,
  eventAt: new Date(`2026-09-20T00:0${version}:00Z`),
  eventVersion: String(new Date(`2026-09-20T00:0${version}:00Z`).getTime() * 1000),
  clearProvenance,
});

test('generic incident creation retains strict policy and no resolution basis', async () => {
  const incident = await open();
  expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
    resolutionPolicy: 'verified_recovery',
    resolutionBasis: null,
  });
});

test.each(['provider', 'operator', 'suppression', 'unknown'] as const)(
  'records typed %s clear provenance and clears it on refire',
  async (clearProvenance) => {
    const incident = await open();
    await applySignalObservation(
      fixture.app.db,
      fixture.tenantA,
      observation(incident.id, 'firing', 1),
    );
    const clear = await applySignalObservation(
      fixture.app.db,
      fixture.tenantA,
      observation(incident.id, 'resolved', 2, clearProvenance),
    );
    expect(clear.signal).toMatchObject({ state: 'resolved', clearProvenance });
    const refire = await applySignalObservation(
      fixture.app.db,
      fixture.tenantA,
      observation(incident.id, 'firing', 3),
    );
    expect(refire.signal).toMatchObject({ state: 'firing', clearProvenance: null });
  },
);

test('provenance-only changes invalidate recovery fences and duplicate delivery does not', async () => {
  const incident = await open();
  const initial = await applySignalObservation(
    fixture.app.db,
    fixture.tenantA,
    observation(incident.id, 'resolved', 1, 'unknown'),
  );
  const before = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    incidentSignalFenceTx(tx, incident.id),
  );
  const authoritative = observation(incident.id, 'resolved', 2, 'provider');
  const changed = await applySignalObservation(fixture.app.db, fixture.tenantA, authoritative);
  const after = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    incidentSignalFenceTx(tx, incident.id),
  );
  expect(changed.signal.version).toBeGreaterThan(initial.signal.version);
  expect(after).not.toBe(before);
  await applySignalObservation(fixture.app.db, fixture.tenantA, authoritative);
  expect(
    await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      incidentSignalFenceTx(tx, incident.id),
    ),
  ).toBe(after);
});

test('operator correction cannot manufacture provider recovery', async () => {
  const incident = await open();
  const firing = await applySignalObservation(
    fixture.app.db,
    fixture.tenantA,
    observation(incident.id, 'firing', 1),
  );
  const result = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    correctIncidentSignalTx(tx, incident.id, firing.signal.id, {
      expectedVersion: firing.signal.version,
      resolvedAt: new Date('2026-09-20T01:00:00Z'),
    }),
  );
  expect(result).toMatchObject({ outcome: 'applied', signal: { clearProvenance: 'operator' } });
});
