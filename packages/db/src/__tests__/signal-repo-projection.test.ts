import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  applySignalObservation,
  createIncident,
  incidentSignals,
  incidents,
  makeDb,
  tenants,
  type DbHandle,
} from '../index';

let admin: DbHandle;
let app: DbHandle;
const tenantId = randomUUID();

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'signal projection' });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

const observation = (
  incidentId: string,
  externalMessageId: string,
  over: Partial<Parameters<typeof applySignalObservation>[2]> = {},
) => ({
  incidentId,
  surface: 'slack',
  channel: 'C-alerts',
  externalMessageId,
  state: 'firing' as const,
  summary: 'Checkout error rate is high',
  contentHash: 'hash-1',
  eventKey: `opened-${externalMessageId}`,
  eventAt: new Date('2026-08-21T02:00:00.000Z'),
  ...over,
});

test('a resolved signal edited to unknown is updated, not refired', async () => {
  const incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: `unknown-after-resolved-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  const externalMessageId = `unknown-after-resolved-${randomUUID()}`;
  await applySignalObservation(app.db, tenantId, observation(incidentId, externalMessageId));
  await applySignalObservation(
    app.db,
    tenantId,
    observation(incidentId, externalMessageId, {
      state: 'resolved',
      contentHash: 'resolved-before-unknown',
      eventKey: 'resolved-before-unknown',
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    }),
  );

  const unknown = await applySignalObservation(
    app.db,
    tenantId,
    observation(incidentId, externalMessageId, {
      state: 'unknown',
      summary: 'A human edited the message to ordinary text.',
      contentHash: 'unknown-after-resolved',
      eventKey: 'unknown-after-resolved',
      eventAt: new Date('2026-08-21T02:02:00.000Z'),
    }),
  );

  expect(unknown).toMatchObject({
    applied: true,
    eventType: 'updated',
    previousState: 'resolved',
    signal: { state: 'unknown' },
  });
});
