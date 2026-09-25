import { reconcileConnectorLifecycle } from '@sre/agent-tools';
import {
  ConnectorRegistry,
  makeStatusCakeConnector,
  statusCakeConnectorDefinition,
} from '@sre/connectors';
import {
  applySignalObservation,
  connectorConfigs,
  createIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  tenants,
} from '@sre/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, expect, test } from 'vitest';
import { createFixture } from './alertmanager-webhook.fixture';

const fixture = createFixture();
const url = 'https://chrislee.kr/';
const start = new Date(Date.now() - 600_000);
const trigger = new Date(start.getTime() + 30_000);
const firstSeen = new Date(start.getTime() + 60_000);
const end = new Date(Date.now() - 60_000);
let firing = true;
let inventory: Array<{ id: string; website_url: string }> = [];
let beforeEpisodeRead: (() => Promise<void>) | undefined;
let inventoryReads = 0;
let inventoryFailures = 0;
let episodeReads = 0;
let episodeFailures = 0;
let overlapping = false;
const otherTenantId = randomUUID();
const opened: string[] = [];

const registry = new ConnectorRegistry([
  {
    ...statusCakeConnectorDefinition,
    create: (config) =>
      makeStatusCakeConnector(config, (async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/uptime') {
          inventoryReads += 1;
          if (inventoryFailures > 0) {
            inventoryFailures -= 1;
            return new Response('unavailable', { status: 500 });
          }
          return Response.json({ data: inventory, metadata: { page_count: 1 } });
        }
        const id = path.split('/')[3]!;
        episodeReads += 1;
        if (episodeFailures > 0) {
          episodeFailures -= 1;
          return new Response('unavailable', { status: 500 });
        }
        if (beforeEpisodeRead) {
          const callback = beforeEpisodeRead;
          beforeEpisodeRead = undefined;
          await callback();
        }
        return Response.json(
          path.endsWith('/periods')
            ? {
                data: firing
                  ? []
                  : [
                      {
                        status: 'down',
                        created_at: start.toISOString(),
                        ended_at: end.toISOString(),
                      },
                      // Two recorded outages that both cover the notice leave no single episode.
                      ...(overlapping
                        ? [
                            {
                              status: 'down',
                              created_at: new Date(start.getTime() + 10_000).toISOString(),
                              ended_at: end.toISOString(),
                            },
                          ]
                        : []),
                    ],
                links: {},
              }
            : path.endsWith('/alerts')
              ? { data: [{ status: 'down', triggered_at: trigger.toISOString() }], links: {} }
              : { data: { id, name: `Test ${id}`, status: firing ? 'down' : 'up', paused: false } },
        );
      }) as typeof fetch),
  },
]);

// Unbound notices are eligible tenant-wide, so each test retires its own incidents to stay isolated.
afterEach(async () => {
  if (opened.length)
    await fixture.admin.db
      .update(incidents)
      .set({ archivedAt: new Date() })
      .where(inArray(incidents.id, opened.splice(0)));
});

afterAll(async () => {
  const db = fixture.admin.db;
  await db.delete(incidentMessages).where(eq(incidentMessages.tenantId, otherTenantId));
  await db.delete(incidentSignals).where(eq(incidentSignals.tenantId, otherTenantId));
  await db.delete(jobs).where(eq(jobs.tenantId, otherTenantId));
  await db.delete(incidents).where(eq(incidents.tenantId, otherTenantId));
  await db.delete(tenants).where(eq(tenants.id, otherTenantId));
});

async function connection() {
  const id = randomUUID();
  await fixture.admin.db.insert(connectorConfigs).values({
    id,
    tenantId: fixture.tenantId,
    type: 'statuscake',
    name: id,
    enabled: true,
    settings: {},
  });
  const connector = registry.create({
    id,
    tenantId: fixture.tenantId,
    type: 'statuscake',
    name: id,
    settings: {},
    getCredential: async () => 'read-bearer',
  });
  Object.defineProperty(connector, 'generation', { value: { id, lifecycleVersion: 0 } });
  // Each connection gets its own never-expiring miss cache, so no test depends on another's.
  misses.set(id, new Map());
  return { id, connector };
}

const misses = new Map<string, Map<string, { reason: string }>>();
const signalMiss = (connectorId: string, signalId: string) =>
  misses.get(connectorId)!.get(`${connectorId}:0:signal:${signalId}`);

/** A stock StatusCake Slack notice as the classify consumer stores it: unbound and advisory. */
async function slackNotice(
  tenantId = fixture.tenantId,
  subjectUrl = url,
  options: { incident?: { id: string }; seenAt?: Date } = {},
) {
  const incident =
    options.incident ??
    (await createIncident(fixture.app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'chrislee.kr',
      severity: 'sev3',
      resolutionPolicy: 'provider_clear',
    }));
  opened.push(incident.id);
  const { signal } = await applySignalObservation(fixture.app.db, tenantId, {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C07ALERTS',
    externalMessageId: randomUUID(),
    state: 'unknown',
    provider: 'statuscake',
    providerGroupKey: `statuscake:uptime:${subjectUrl}`,
    monitorKey: `slack:${randomUUID()}`,
    summary: `Website | Your site '${subjectUrl}' went Down [Timeout / Connection Refused]`,
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: firstSeen,
  });
  // The platform saw the notice during the provider outage unless told otherwise.
  await fixture.admin.db
    .update(incidentSignals)
    .set({ firstSeenAt: options.seenAt ?? firstSeen })
    .where(eq(incidentSignals.id, signal.id));
  return { incident, signal: (await row(signal.id))! };
}

async function row(signalId: string) {
  const [signal] = await fixture.admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.id, signalId));
  return signal;
}

type RecoveryQueue = Parameters<typeof reconcileConnectorLifecycle>[0]['queue'];

const reconcile = (
  connector: Awaited<ReturnType<typeof connection>>['connector'],
  queue: RecoveryQueue = fixture.webhookDeps.route.queue,
) =>
  reconcileConnectorLifecycle({
    db: fixture.app.db,
    tenantId: fixture.tenantId,
    connector,
    hub: fixture.webhookDeps.hub,
    queue,
    subjectMisses: misses.get(connector.id),
  });

const history = (incidentId: string) =>
  fixture.webhookDeps.hub.history(fixture.tenantId, incidentId);

test('a notice naming exactly one test binds to its verified episode and later clears from provider evidence', async () => {
  const { id, connector } = await connection();
  const { incident, signal } = await slackNotice();
  inventory = [
    { id: '73', website_url: 'https://chrislee.kr' },
    { id: '74', website_url: 'http://chrislee.kr' },
  ];
  firing = true;
  try {
    await reconcile(connector);
    await reconcile(connector);
    const bound = await row(signal.id);
    expect(bound).toMatchObject({
      dataSourceId: id,
      provider: 'statuscake',
      providerFingerprint: createHash('sha256').update('uptime:73').digest('hex'),
      startsAt: trigger,
      labels: { monitor_id: '73', check_type: 'uptime' },
      state: 'unknown',
      summary: signal.summary,
      lastEventKey: signal.lastEventKey,
      version: signal.version + 1,
      signalSource: { kind: 'monitor', lifecycleState: 'firing', lifecycleVersion: 0 },
    });
    // The operator binding list and its capacity are untouched.
    const [config] = await fixture.admin.db
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id));
    expect(config).toMatchObject({ settings: {}, lifecycleVersion: 0 });
    const audits = (await history(incident.id)).filter((message) =>
      message.content.startsWith('Bound this notification'),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ author: 'system' });
    expect(audits[0]!.content).toContain(`uptime test 73, episode ${trigger.toISOString()}`);

    firing = false;
    await reconcile(connector);
    expect(await row(signal.id)).toMatchObject({
      state: 'resolved',
      clearProvenance: 'provider',
      providerClearGeneration: 0,
      endsAt: end,
    });
    const recovery = await fixture.admin.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, fixture.tenantId),
          eq(jobs.type, 'recovery.verify'),
          sql`${jobs.payload}->>'incidentId' = ${incident.id}`,
        ),
      );
    expect(recovery).toHaveLength(1);
  } finally {
    firing = true;
  }
});

test.each([
  {
    name: 'no test checks the URL',
    tests: [{ id: '80', website_url: 'https://other.example' }],
    reason: 'no_matching_monitor',
  },
  {
    name: 'two tests check the URL',
    tests: [
      { id: '81', website_url: 'https://chrislee.kr' },
      { id: '82', website_url: 'https://chrislee.kr/' },
    ],
    reason: 'ambiguous_monitor',
  },
])('$name: the notice stays unbound and is annotated once', async ({ tests, reason }) => {
  const { connector } = await connection();
  const { incident, signal } = await slackNotice();
  inventory = tests;
  inventoryReads = 0;
  await reconcile(connector);
  await reconcile(connector);
  expect(await row(signal.id)).toEqual(signal);
  // The second pass answers from the remembered miss instead of listing tests again.
  expect(inventoryReads).toBe(1);
  const notes = (await history(incident.id)).filter((message) => message.content.includes(reason));
  expect(notes).toHaveLength(1);
  expect(notes[0]!.content).toContain('no recovery has been inferred');
});

test('a unique URL match alone never binds: the provider must report an outage covering the notice', async () => {
  const { connector } = await connection();
  const { incident, signal } = await slackNotice();
  // Seen after the only recorded outage ended, so no StatusCake episode covers it.
  await fixture.admin.db
    .update(incidentSignals)
    .set({ firstSeenAt: new Date() })
    .where(eq(incidentSignals.id, signal.id));
  const unbound = (await row(signal.id))!;
  inventory = [{ id: '73', website_url: url }];
  inventoryReads = 0;
  firing = false;
  try {
    await reconcile(connector);
    await reconcile(connector);
  } finally {
    firing = true;
  }
  expect(await row(signal.id)).toEqual(unbound);
  expect(
    (await history(incident.id)).some((message) => message.content.startsWith('Bound this')),
  ).toBe(false);
  // The provider's answer about this notice is remembered, so the second pass reads nothing.
  expect(inventoryReads).toBe(1);
  expect(signalMiss(connector.id, signal.id)).toEqual({ reason: 'ambiguous_episode' });
});

test('two recorded outages covering the notice leave it unbound and annotated', async () => {
  const { connector } = await connection();
  const { incident, signal } = await slackNotice();
  inventory = [{ id: '73', website_url: url }];
  firing = false;
  overlapping = true;
  try {
    await reconcile(connector);
  } finally {
    firing = true;
    overlapping = false;
  }
  expect(await row(signal.id)).toEqual(signal);
  const messages = await history(incident.id);
  expect(messages.some((message) => message.content.startsWith('Bound this'))).toBe(false);
  expect(messages.filter((message) => message.content.includes('ambiguous_episode'))).toHaveLength(
    1,
  );
});

test('an unreadable inventory is retried on every pass and binds once it recovers', async () => {
  const { id, connector } = await connection();
  const { signal } = await slackNotice();
  inventory = [{ id: '73', website_url: url }];
  inventoryReads = 0;
  inventoryFailures = 2;
  try {
    await reconcile(connector);
    await reconcile(connector);
    expect(inventoryReads).toBe(2);
    expect(await row(signal.id)).toEqual(signal);
    await reconcile(connector);
  } finally {
    inventoryFailures = 0;
  }
  expect(inventoryReads).toBe(3);
  expect(await row(signal.id)).toMatchObject({ dataSourceId: id });
});

test('a failed outage read is not remembered, so the next pass reads StatusCake again and binds', async () => {
  const { id, connector } = await connection();
  const { signal } = await slackNotice();
  inventory = [{ id: '73', website_url: url }];
  episodeReads = 0;
  episodeFailures = 1;
  try {
    expect((await reconcile(connector)).unresolved).toEqual([
      { signalId: signal.id, reason: 'provider_read_failed' },
    ]);
  } finally {
    episodeFailures = 0;
  }
  expect(signalMiss(id, signal.id)).toBeUndefined();
  expect(await row(signal.id)).toEqual(signal);
  episodeReads = 0;
  await reconcile(connector);
  expect(episodeReads).toBeGreaterThan(0);
  expect(await row(signal.id)).toMatchObject({ dataSourceId: id });
});

test.each([
  { name: 'before the pass', during: false },
  { name: 'while the provider is read', during: true },
])('an incident resolved $name keeps its notice unbound', async ({ during }) => {
  const { connector } = await connection();
  const { incident, signal } = await slackNotice();
  inventory = [{ id: '73', website_url: url }];
  const resolve = async () => {
    await fixture.admin.db
      .update(incidents)
      .set({ status: 'resolved' })
      .where(eq(incidents.id, incident.id));
  };
  if (during) beforeEpisodeRead = resolve;
  else await resolve();
  await reconcile(connector);
  beforeEpisodeRead = undefined;
  expect(await row(signal.id)).toEqual(signal);
  expect(
    (await history(incident.id)).some((message) => message.content.startsWith('Bound this')),
  ).toBe(false);
});

test('an episode another signal already owns is skipped and annotated, never double-bound', async () => {
  const { id, connector } = await connection();
  const owner = await slackNotice();
  await fixture.admin.db
    .update(incidentSignals)
    .set({
      dataSourceId: id,
      providerFingerprint: createHash('sha256').update('uptime:73').digest('hex'),
      startsAt: trigger,
      labels: { monitor_id: '73', check_type: 'uptime' },
    })
    .where(eq(incidentSignals.id, owner.signal.id));
  const { incident, signal } = await slackNotice();
  inventory = [{ id: '73', website_url: url }];
  inventoryReads = 0;
  await reconcile(connector);
  await reconcile(connector);
  expect(await row(signal.id)).toEqual(signal);
  const notes = (await history(incident.id)).filter((message) =>
    message.content.includes('provider_episode_already_bound'),
  );
  expect(notes).toHaveLength(1);
  // While the owner is still firing, later passes do not re-read StatusCake for this notice.
  expect(inventoryReads).toBe(1);
  expect(signalMiss(id, signal.id)).toEqual({ reason: 'provider_episode_already_bound' });
});

test('a connector generation change during the provider read cannot bind stale evidence', async () => {
  const { id, connector } = await connection();
  const { incident, signal } = await slackNotice();
  inventory = [{ id: '73', website_url: url }];
  beforeEpisodeRead = async () => {
    await fixture.admin.db
      .update(connectorConfigs)
      .set({ lifecycleVersion: 1 })
      .where(eq(connectorConfigs.id, id));
  };
  await reconcile(connector);
  expect(await row(signal.id)).toEqual(signal);
  expect(
    (await history(incident.id)).some((message) => message.content.startsWith('Bound this')),
  ).toBe(false);
});

test("another tenant's matching notice is never read or bound", async () => {
  await ensureOtherTenant();
  const foreign = await slackNotice(otherTenantId);
  const { id, connector } = await connection();
  const own = await slackNotice();
  inventory = [{ id: '73', website_url: url }];
  await reconcile(connector);
  expect(await row(own.signal.id)).toMatchObject({ dataSourceId: id });
  expect(await row(foreign.signal.id)).toEqual(foreign.signal);
  expect(
    await fixture.admin.db
      .select({ id: incidentMessages.id })
      .from(incidentMessages)
      .where(
        and(
          eq(incidentMessages.tenantId, otherTenantId),
          inArray(incidentMessages.incidentId, [foreign.incident.id]),
          sql`${incidentMessages.content} like 'Bound this%'`,
        ),
      ),
  ).toHaveLength(0);
});

async function ensureOtherTenant() {
  await fixture.admin.db
    .insert(tenants)
    .values({ id: otherTenantId, name: 'Other tenant' })
    .onConflictDoNothing();
}

const recoveryJobs = (incidentId: string) =>
  fixture.admin.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, fixture.tenantId),
        eq(jobs.type, 'recovery.verify'),
        sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
      ),
    );

test('duplicate Down notices of one outage clear with the bound episode and start recovery once', async () => {
  const { id, connector } = await connection();
  const first = await slackNotice();
  const second = await slackNotice(fixture.tenantId, url, {
    incident: first.incident,
    seenAt: new Date(firstSeen.getTime() + 60_000),
  });
  inventory = [{ id: '73', website_url: url }];
  const real = fixture.webhookDeps.route.queue;
  // Throws after the owner's transaction has cleared the duplicate, so the whole clear rolls back.
  const failing: RecoveryQueue = {
    insertRecoveryTx: () => Promise.reject(new Error('insert failed')),
    publishJob: (jobId) => real.publishJob(jobId),
  };
  firing = true;
  try {
    await reconcile(connector);
    const bound = [await row(first.signal.id), await row(second.signal.id)].filter(
      (signal) => signal?.dataSourceId === id,
    );
    // Only one signal can own the episode; the other is the duplicate.
    expect(bound).toHaveLength(1);
    // The owner's pass read StatusCake while the owner was firing, so the duplicate's
    // already-bound answer is cached. Its clear below must not depend on that cache.
    const duplicateId = bound[0]!.id === first.signal.id ? second.signal.id : first.signal.id;
    expect(signalMiss(id, duplicateId)).toEqual({ reason: 'provider_episode_already_bound' });
    firing = false;
    // A rolled-back clear leaves the duplicate unresolved, so it is still visited in the same pass.
    expect((await reconcile(connector, failing)).unresolved).toEqual([
      { signalId: bound[0]!.id, reason: 'processing_failed' },
      { signalId: duplicateId, reason: 'provider_episode_already_bound' },
    ]);
    expect(await row(duplicateId)).toMatchObject({ state: 'unknown', clearProvenance: null });
    // So does a refused clear: a stored event newer than the clear makes it stale.
    const storedVersion = (lastEventVersion: number | null) =>
      fixture.admin.db
        .update(incidentSignals)
        .set({ lastEventVersion })
        .where(eq(incidentSignals.id, duplicateId));
    await storedVersion((Date.now() + 86_400_000) * 1000);
    expect((await reconcile(connector)).unresolved).toEqual([
      { signalId: duplicateId, reason: 'provider_episode_already_bound' },
    ]);
    expect(await row(duplicateId)).toMatchObject({ state: 'unknown', clearProvenance: null });
    await storedVersion(null);
    // Rows are visited in id order, so the owner clears the duplicate before the duplicate's turn,
    // and a cached miss for an already-cleared row is not reported as unresolved.
    expect((await reconcile(connector)).unresolved).toEqual([]);
    await reconcile(connector);
  } finally {
    firing = true;
  }
  const signals = [(await row(first.signal.id))!, (await row(second.signal.id))!];
  expect(signals.map((signal) => [signal.state, signal.clearProvenance])).toEqual([
    ['resolved', 'provider'],
    ['resolved', 'provider'],
  ]);
  const duplicate = signals.find((signal) => signal.dataSourceId === null)!;
  expect(duplicate).toMatchObject({ providerClearGeneration: null, startsAt: null });
  expect(await recoveryJobs(first.incident.id)).toHaveLength(1);
  const notes = (await history(first.incident.id)).filter((message) =>
    message.content.includes('also clears this duplicate notice'),
  );
  expect(notes).toHaveLength(1);
});

test('a provider clear leaves notices of another outage or another URL alone', async () => {
  const { connector } = await connection();
  const bound = await slackNotice();
  const otherUrl = await slackNotice(fixture.tenantId, 'https://other.example/', {
    incident: bound.incident,
  });
  // Seen before StatusCake's recorded trigger, so it belongs to an earlier outage.
  const earlier = await slackNotice(fixture.tenantId, url, {
    incident: bound.incident,
    seenAt: new Date(start.getTime() - 60_000),
  });
  let later!: Awaited<ReturnType<typeof slackNotice>>;
  inventory = [{ id: '73', website_url: url }];
  firing = true;
  try {
    await reconcile(connector);
    firing = false;
    // Posted after StatusCake recorded the outage's end, so it reports a later outage.
    later = await slackNotice(fixture.tenantId, url, {
      incident: bound.incident,
      seenAt: new Date(),
    });
    // The cursor resumes after the last row of the previous pass; the second pass wraps around.
    await reconcile(connector);
    await reconcile(connector);
  } finally {
    firing = true;
  }
  expect(await row(bound.signal.id)).toMatchObject({
    state: 'resolved',
    clearProvenance: 'provider',
  });
  for (const untouched of [earlier, later, otherUrl])
    expect((await row(untouched.signal.id))!).toMatchObject({
      state: 'unknown',
      clearProvenance: null,
      dataSourceId: null,
      version: untouched.signal.version,
    });
  // The incident still holds unresolved notices, so no recovery starts.
  expect(await recoveryJobs(bound.incident.id)).toHaveLength(0);
});
