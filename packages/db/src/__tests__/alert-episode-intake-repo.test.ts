import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  alertEpisodeIntakes,
  connectorConfigs,
  makeDb,
  tenants,
  upsertAlertEpisodeIntake,
  withTenant,
  type AlertEpisodeIntakeInput,
  type DbHandle,
} from '../index';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let dataSourceId: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantId = randomUUID();
  dataSourceId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Alert intake tenant' });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(connectorConfigs).values({
      id: dataSourceId,
      tenantId,
      name: 'Alert intake source',
      type: 'prometheus',
      settings: {},
    }),
  );
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(alertEpisodeIntakes).where(eq(alertEpisodeIntakes.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

const input = (over: Partial<AlertEpisodeIntakeInput>): AlertEpisodeIntakeInput => ({
  dataSourceId,
  providerFingerprint: randomUUID(),
  startsAt: new Date('2026-09-01T00:00:00Z'),
  materialHash: 'intake-identity',
  observation: {
    status: 'firing',
    groupKey: 'checkout',
    alertName: 'CheckoutErrors',
    labels: {},
    annotations: {},
    endsAt: null,
    generatorUrl: null,
    externalUrl: null,
  },
  channel: 'C-intake',
  observedAt: new Date('2026-09-01T00:00:01Z'),
  ...over,
});

test('accepts an intake identified by either its start time or its opaque episode key', async () => {
  await expect(upsertAlertEpisodeIntake(app.db, tenantId, input({}))).resolves.toBeDefined();
  await expect(
    upsertAlertEpisodeIntake(
      app.db,
      tenantId,
      input({ startsAt: null, opaqueEpisodeKey: `datadog:${randomUUID()}` }),
    ),
  ).resolves.toBeDefined();
});

// Both unique constraints treat NULLs as distinct, so an unkeyed row would duplicate silently.
test('rejects an intake with neither a start time nor an opaque episode key', async () => {
  const error = await upsertAlertEpisodeIntake(app.db, tenantId, input({ startsAt: null })).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).not.toBeNull();
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
  expect(String(cause)).toContain('alert_episode_intakes_episode_identity');
});
