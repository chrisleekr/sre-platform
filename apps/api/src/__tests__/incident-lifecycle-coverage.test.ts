import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { applySignalObservation, createIncident } from '@sre/db';
import { createFixture } from './incidents.fixture';
const fixture = createFixture();
test.each(['legacy_provider', 'human_report', 'platform_observer'] as const)(
  'incident coverage distinguishes %s lifecycle semantics',
  async (kind) => {
    const incident = await createIncident(fixture.app.db, fixture.tenantA, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    await applySignalObservation(fixture.app.db, fixture.tenantA, {
      incidentId: incident.id,
      surface: kind === 'platform_observer' ? 'kubernetes' : 'slack',
      channel: 'alerts',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Recorded observation',
      contentHash: 'historical',
      eventKey: randomUUID(),
      eventAt: new Date(),
      signalSource: {
        kind: kind === 'legacy_provider' ? 'connector' : kind,
        provider: kind === 'platform_observer' ? 'kubernetes' : 'slack',
        dataSourceId: null,
        externalId: 'recorded-source',
        displayName: 'Recorded source',
        observedAt: new Date().toISOString(),
      },
    });
    const response = await fixture.api.request(
      `/incidents/${incident.id}/workspace`,
      fixture.auth(await fixture.sign(fixture.orgA)),
    );
    expect(response.status).toBe(200);
    const detail = (await response.json()) as { signals: Array<{ lifecycleCoverage?: string }> };
    // Pins the read so an absent signal cannot pass the undefined cases.
    expect(detail.signals).toHaveLength(1);
    expect(detail.signals[0]?.lifecycleCoverage).toBe(
      kind === 'legacy_provider' ? 'binding_required' : undefined,
    );
  },
);
