import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createIncident, incidents, services } from '@sre/db';
import { eq } from 'drizzle-orm';
import { createFixture } from './incidents.fixture';

const fixture = createFixture();
test.each(['Payments', null])(
  'workspace exposes service teams independently of attention',
  async (team) => {
    const service = `team-context-${randomUUID()}`;
    await fixture.admin.db
      .insert(services)
      .values({ tenantId: fixture.tenantC, name: service, team });
    const incident = await createIncident(fixture.app.db, fixture.tenantC, {
      fingerprint: randomUUID(),
      alertSource: 'manual',
      service,
      severity: 'sev3',
      title: 'Completed service check',
    });
    await fixture.admin.db
      .update(incidents)
      .set({ status: 'resolved' })
      .where(eq(incidents.id, incident.id));
    const response = await fixture.api.request(
      `/incidents/${incident.id}/workspace`,
      fixture.auth(await fixture.sign(fixture.orgC)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attention: null,
      serviceTeams: team ? [team] : [],
    });
  },
);
