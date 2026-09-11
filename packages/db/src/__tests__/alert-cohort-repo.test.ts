import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  alertCohortMembers,
  alertCohorts,
  applySignalObservation,
  claimAlertCohortAnalysis,
  connectorConfigs,
  createIncident,
  getPreviousMonitorEpisodeTx,
  getPreviousProviderEpisode,
  getPreviousSlackMonitorEpisodeTx,
  getSignalByProviderEpisode,
  incidentSignals,
  incidents,
  joinAlertCohortTx,
  listActiveSlackSignalsByMonitorKeys,
  makeDb,
  settleAlertCohortTx,
  tenants,
  withTenant,
  type DbHandle,
} from '../index';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Alert cohort tenant' });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(alertCohortMembers).where(eq(alertCohortMembers.tenantId, tenantId));
    await admin.db.delete(alertCohorts).where(eq(alertCohorts.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

async function dataSource(name: string): Promise<string> {
  const id = randomUUID();
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(connectorConfigs).values({
      id,
      tenantId,
      name,
      type: 'prometheus',
      settings: { baseUrl: `https://${name}.example`, authType: 'none' },
      enabled: true,
    }),
  );
  return id;
}

async function episode(dataSourceId: string, suffix: string, startsAt: Date) {
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `cohort-${suffix}-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev2',
    investigationStatus: 'assessed',
  });
  const observed = await applySignalObservation(app.db, tenantId, {
    incidentId: incident.id,
    dataSourceId,
    provider: 'alertmanager',
    providerFingerprint: `fingerprint-${suffix}`,
    startsAt,
    materialHash: `material-${suffix}`,
    surface: 'alertmanager',
    channel: dataSourceId,
    externalMessageId: `episode-${suffix}`,
    state: 'firing',
    summary: `Episode ${suffix}`,
    contentHash: `content-${suffix}`,
    eventKey: `event-${suffix}`,
    eventAt: startsAt,
  });
  return observed.signal;
}

function join(dataSourceId: string, signalId: string, observedAt: Date, windowMs = 120_000) {
  return withTenant(app.db, tenantId, (tx) =>
    joinAlertCohortTx(tx, tenantId, {
      sourceScopeKey: `connector:${dataSourceId}`,
      dataSourceId,
      signalId,
      observedAt,
      windowMs,
    }),
  );
}

test('cohorts use fixed source-scoped boundaries and idempotent membership', async () => {
  const sourceA = await dataSource(`cohort-a-${randomUUID().slice(0, 8)}`);
  const sourceB = await dataSource(`cohort-b-${randomUUID().slice(0, 8)}`);
  const startedAt = new Date('2026-08-26T00:00:00.000Z');
  const endsAt = new Date(startedAt.getTime() + 120_000);
  const afterEnd = new Date(endsAt.getTime() + 1);
  const first = await episode(sourceA, randomUUID(), startedAt);
  const atBoundary = await episode(sourceA, randomUUID(), endsAt);
  const afterBoundary = await episode(sourceA, randomUUID(), afterEnd);
  const otherSource = await episode(sourceB, randomUUID(), startedAt);

  const firstCohort = await join(sourceA, first.id, startedAt);
  expect((await join(sourceA, first.id, new Date(startedAt.getTime() + 10_000))).id).toBe(
    firstCohort.id,
  );
  expect((await join(sourceA, atBoundary.id, endsAt)).id).toBe(firstCohort.id);
  const nextCohort = await join(sourceA, afterBoundary.id, afterEnd);
  const isolatedCohort = await join(sourceB, otherSource.id, startedAt);

  expect(nextCohort.id).not.toBe(firstCohort.id);
  expect(isolatedCohort.id).not.toBe(firstCohort.id);
  const rows = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(alertCohorts).where(eq(alertCohorts.id, firstCohort.id)),
  );
  expect(rows[0]).toMatchObject({
    state: 'collecting',
    windowStartedAt: startedAt,
    windowEndsAt: endsAt,
    lastAlertAt: endsAt,
  });
});

test('concurrent first arrivals create one cohort with one stable anchor', async () => {
  const source = await dataSource(`cohort-concurrent-${randomUUID().slice(0, 8)}`);
  const observedAt = new Date('2026-08-26T01:00:00.000Z');
  const [first, second] = await Promise.all([
    episode(source, randomUUID(), observedAt),
    episode(source, randomUUID(), observedAt),
  ]);

  const joined = await Promise.all([
    join(source, first.id, observedAt),
    join(source, second.id, observedAt),
  ]);
  expect(joined[0].id).toBe(joined[1].id);
  expect([first.id, second.id]).toContain(joined[0].anchorSignalId);
  const members = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(alertCohortMembers).where(eq(alertCohortMembers.cohortId, joined[0].id)),
  );
  expect(members).toHaveLength(2);
});

test('bounds model analysis to five stable incidents and seals membership before analysis', async () => {
  const source = await dataSource(`cohort-bounded-${randomUUID().slice(0, 8)}`);
  const observedAt = new Date('2026-08-26T01:30:00.000Z');
  const signals = await Promise.all(
    Array.from({ length: 7 }, (_, index) => episode(source, `bounded-${index}`, observedAt)),
  );
  let cohortId = '';
  for (const signal of signals) cohortId = (await join(source, signal.id, observedAt)).id;

  const jobId = randomUUID();
  const claimed = await claimAlertCohortAnalysis(app.db, tenantId, cohortId, jobId);
  expect(claimed?.cohort.state).toBe('analyzing');
  expect(claimed?.incidents.map((incident) => incident.id)).toEqual(
    signals.slice(0, 5).map((signal) => signal.incidentId),
  );
  expect(await claimAlertCohortAnalysis(app.db, tenantId, cohortId, jobId)).not.toBeNull();

  const lateSignal = await episode(source, 'bounded-late', observedAt);
  const lateCohort = await join(source, lateSignal.id, observedAt);
  expect(lateCohort.id).not.toBe(cohortId);
  await withTenant(app.db, tenantId, (tx) => settleAlertCohortTx(tx, cohortId));
  expect(await claimAlertCohortAnalysis(app.db, tenantId, cohortId, jobId)).toBeNull();
});

test('archived incidents remain deduplicated but are excluded from recurrence and active routing', async () => {
  const source = await dataSource(`archived-routing-${randomUUID().slice(0, 8)}`);
  const startedAt = new Date('2026-08-26T02:00:00.000Z');
  const archivedIncident = await createIncident(app.db, tenantId, {
    fingerprint: `archived-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev2',
    investigationStatus: 'assessed',
  });
  const observed = await applySignalObservation(app.db, tenantId, {
    incidentId: archivedIncident.id,
    dataSourceId: source,
    provider: 'alertmanager',
    providerFingerprint: 'archived-provider-fingerprint',
    startsAt: startedAt,
    monitorKey: 'monitor:checkout-errors',
    materialHash: 'archived-material',
    surface: 'slack',
    channel: 'C-ARCHIVED',
    externalMessageId: 'archived-episode',
    state: 'firing',
    summary: 'Archived checkout errors',
    contentHash: 'archived-content',
    eventKey: 'archived:firing:producer:alertmanager-bot',
    eventAt: startedAt,
  });
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(incidents)
      .set({ archivedAt: new Date('2026-08-26T02:01:00.000Z') })
      .where(eq(incidents.id, archivedIncident.id)),
  );

  expect(
    await getSignalByProviderEpisode(
      app.db,
      tenantId,
      source,
      'archived-provider-fingerprint',
      startedAt,
    ),
  ).toMatchObject({ id: observed.signal.id });
  expect(
    await getPreviousProviderEpisode(
      app.db,
      tenantId,
      source,
      'archived-provider-fingerprint',
      new Date('2026-08-26T03:00:00.000Z'),
    ),
  ).toBeUndefined();
  await withTenant(app.db, tenantId, async (tx) => {
    expect(
      await getPreviousMonitorEpisodeTx(
        tx,
        source,
        'monitor:checkout-errors',
        new Date('2026-08-26T03:00:00.000Z'),
        randomUUID(),
      ),
    ).toBeUndefined();
    expect(
      await getPreviousSlackMonitorEpisodeTx(
        tx,
        'C-ARCHIVED',
        'alertmanager-bot',
        'monitor:checkout-errors',
        randomUUID(),
      ),
    ).toBeUndefined();
  });
  expect(
    await listActiveSlackSignalsByMonitorKeys(app.db, tenantId, 'C-ARCHIVED', 'alertmanager-bot', [
      'monitor:checkout-errors',
    ]),
  ).toEqual([]);
});
