// Live-infra test: admin seeds tenant and connector rows; reconciliation runs as app_user so RLS binds.
import type { AlertLifecycleQuery, IDataSourceConnector } from '@sre/connectors';
import {
  applySignalObservation,
  connectorConfigs,
  createIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  lockIncidentWorkTx,
  makeDb,
  tenants,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { reconcileConnectorLifecycle } from '../connector-lifecycle';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;

beforeAll(() => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
});

afterAll(async () => {
  await admin?.close();
  await app?.close();
});

type RedisStub = ConstructorParameters<typeof ConversationHub>[1];

function hubWith(redis: Partial<Record<'publish' | 'xadd', () => Promise<unknown>>>) {
  const stub = { publish: async () => 1, xadd: async () => '0-0', ...redis };
  return new ConversationHub(app.db, stub as unknown as RedisStub);
}

function recoveryQueue(publishJob: (jobId: string) => Promise<void> = async () => {}) {
  return {
    insertRecoveryTx: vi.fn(async () => ({ jobId: randomUUID() })),
    publishJob: vi.fn(publishJob),
  };
}

/** Seeds one tenant, one enabled connector, and one firing signal per incident, sorted by signal id. */
async function seed(count: number) {
  const tenantId = randomUUID();
  const connectorId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: tenantId });
  await admin.db.insert(connectorConfigs).values({
    id: connectorId,
    tenantId,
    type: 'statuscake',
    name: connectorId,
    enabled: true,
  });
  const signals: Array<{ id: string; incidentId: string; monitorId: string; startsAt: Date }> = [];
  for (let index = 0; index < count; index++) {
    const incident = await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
      resolutionPolicy: 'provider_clear',
    });
    const monitorId = `monitor-${index}`;
    const startsAt = new Date(Date.now() - 60_000);
    const applied = await applySignalObservation(app.db, tenantId, {
      incidentId: incident.id,
      dataSourceId: connectorId,
      provider: 'statuscake',
      providerFingerprint: randomUUID(),
      startsAt,
      labels: { monitor_id: monitorId, check_type: 'uptime' },
      signalSource: {
        kind: 'monitor',
        lifecycleVersion: 0,
        provider: 'statuscake',
        dataSourceId: connectorId,
        externalId: monitorId,
        displayName: 'Checkout uptime',
        observedAt: new Date().toISOString(),
      },
      surface: 'slack',
      channel: 'C_PROVIDER',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Checkout is down.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
      monitorKey: monitorId,
    });
    signals.push({ id: applied.signal.id, incidentId: incident.id, monitorId, startsAt });
  }
  signals.sort((left, right) => left.id.localeCompare(right.id));
  return { tenantId, connectorId, signals };
}

function connectorFor(
  connectorId: string,
  signals: Awaited<ReturnType<typeof seed>>['signals'],
  readEpisode?: (query: AlertLifecycleQuery) => Promise<void>,
  text: {
    alertName: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  } = {
    alertName: 'Checkout uptime',
    labels: {},
    annotations: {},
  },
): IDataSourceConnector {
  // A provider reports a completed episode's end once, so repeated reads return the same instant.
  const endsAt = new Date();
  return {
    id: connectorId,
    type: 'statuscake',
    generation: { id: connectorId, lifecycleVersion: 0 },
    alertLifecycle: {
      readEpisode: async (query: AlertLifecycleQuery) => {
        await readEpisode?.(query);
        const signal = signals.find((entry) => entry.monitorId === query.monitorId)!;
        return {
          status: 'verified' as const,
          observations: [
            {
              provider: 'statuscake' as const,
              status: 'resolved' as const,
              fingerprint: signal.id,
              monitorIdentity: signal.monitorId,
              startsAt: signal.startsAt,
              endsAt,
              ...text,
              generatorUrl: null,
            },
          ],
        };
      },
    },
  } as unknown as IDataSourceConnector;
}

async function cursorAfter(connectorId: string) {
  const [row] = await admin.db
    .select({ pollCursor: connectorConfigs.pollCursor })
    .from(connectorConfigs)
    .where(eq(connectorConfigs.id, connectorId));
  return (row?.pollCursor as { lifecycle?: { after?: string } } | null)?.lifecycle?.after;
}

test('post-commit publish failures do not abort the batch or the cursor write', async () => {
  const { tenantId, connectorId, signals } = await seed(2);
  const failure = async () => {
    throw new Error('Temporary fanout failure');
  };
  const queue = recoveryQueue(failure);

  const result = await reconcileConnectorLifecycle({
    db: app.db,
    tenantId,
    connector: connectorFor(connectorId, signals),
    hub: hubWith({ publish: failure, xadd: failure }),
    queue,
  });

  expect(result).toEqual({ verified: 2, unresolved: [] });
  expect(queue.publishJob).toHaveBeenCalledTimes(2);
  expect(await cursorAfter(connectorId)).toBe(signals.at(-1)!.id);
});

test('a replayed provider clear on a later poll does not re-enqueue recovery', async () => {
  const { tenantId, connectorId, signals } = await seed(1);
  // Match the StatusCake reader, which keeps monitor identity in the labels it returns.
  const connector = connectorFor(connectorId, signals, undefined, {
    alertName: 'Checkout uptime',
    labels: { monitor_id: signals[0]!.monitorId, check_type: 'uptime' },
    annotations: {},
  });
  const queue = recoveryQueue();
  const poll = () =>
    reconcileConnectorLifecycle({ db: app.db, tenantId, connector, hub: hubWith({}), queue });

  expect(await poll()).toEqual({ verified: 1, unresolved: [] });
  expect(await poll()).toEqual({ verified: 1, unresolved: [] });

  // A second enqueue would move a scheduled recheck to now on every 30-second poll.
  expect(queue.insertRecoveryTx).toHaveBeenCalledTimes(1);
});

test('a signal whose provider read throws is reported and the next signal is still verified', async () => {
  const { tenantId, connectorId, signals } = await seed(2);
  const [broken, healthy] = signals;

  const result = await reconcileConnectorLifecycle({
    db: app.db,
    tenantId,
    connector: connectorFor(connectorId, signals, async (query) => {
      if (query.monitorId === broken!.monitorId) throw new Error('unexpected provider payload');
    }),
    hub: hubWith({}),
    queue: recoveryQueue(),
  });

  expect(result).toEqual({
    verified: 1,
    unresolved: [{ signalId: broken!.id, reason: 'processing_failed' }],
  });
  expect(await cursorAfter(connectorId)).toBe(healthy!.id);
  const gapMessages = await admin.db
    .select({ content: incidentMessages.content })
    .from(incidentMessages)
    .where(
      and(
        eq(incidentMessages.tenantId, tenantId),
        eq(
          incidentMessages.originMessageId,
          `lifecycle-gap:${connectorId}:0:${broken!.id}:processing_failed`,
        ),
      ),
    );
  expect(gapMessages).toEqual([
    {
      content:
        'Provider lifecycle verification failed internally and will be retried on a later poll; no recovery has been inferred.',
    },
  ]);
});

test('provider text from a verified recovery is scrubbed before the signal stores it', async () => {
  const { tenantId, connectorId, signals } = await seed(1);
  const credential = `ghp_${'c'.repeat(36)}`;

  const result = await reconcileConnectorLifecycle({
    db: app.db,
    tenantId,
    connector: connectorFor(connectorId, signals, undefined, {
      alertName: `Checkout ${credential}`,
      labels: { note: `token ${credential}` },
      annotations: { summary: `see ${credential}` },
    }),
    hub: hubWith({}),
    queue: recoveryQueue(),
  });

  expect(result).toEqual({ verified: 1, unresolved: [] });
  const [stored] = await admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.id, signals[0]!.id));
  expect(stored!.state).toBe('resolved');
  const durable = JSON.stringify(stored);
  expect(durable).toContain('Checkout');
  expect(durable).not.toContain(credential);
});

test('recovery takes response-group work locks before the incident row lock', async () => {
  const { tenantId, connectorId, signals } = await seed(1);
  const [signal] = signals;
  const [appRow] = await app.db.execute<{ role: string }>(sql`select current_user as role`);
  const appRole = appRow!.role;
  let releaseHolder!: () => void;
  const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderLocked!: () => void;
  const holderHasGroupLock = new Promise<void>((resolve) => (holderLocked = resolve));

  // Mirrors a signal writer: group work lock first, then the incident row.
  const holder: Promise<unknown> = admin.db.transaction(async (tx) => {
    await lockIncidentWorkTx(tx, tenantId, [signal!.incidentId]);
    holderLocked();
    await holderMayFinish;
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.id, signal!.incidentId))
      .for('update');
  });
  await holderHasGroupLock;

  const reconciled = reconcileConnectorLifecycle({
    db: app.db,
    tenantId,
    connector: connectorFor(connectorId, signals),
    hub: hubWith({}),
    queue: recoveryQueue(),
  });
  // Reconcile must actually block on the held advisory lock, or the ordering is never exercised.
  // Scoped to the app role because the holder runs as admin and cannot be the waiter.
  await vi.waitFor(
    async () => {
      const waiting = await admin.db.execute(
        sql`select pid from pg_stat_activity
            where wait_event_type = 'Lock' and wait_event = 'advisory'
              and datname = current_database() and usename = ${appRole}`,
      );
      expect(waiting.length).toBeGreaterThan(0);
    },
    { timeout: 5_000, interval: 50 },
  );
  releaseHolder();

  // An inverted order deadlocks here and Postgres aborts one side.
  const [holderOutcome, reconcileOutcome] = await Promise.allSettled([holder, reconciled]);
  expect(holderOutcome.status).toBe('fulfilled');
  expect(reconcileOutcome).toEqual({
    status: 'fulfilled',
    value: { verified: 1, unresolved: [] },
  });
}, 20_000);
