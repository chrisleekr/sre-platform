import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  EMBED_DIM,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  makeDb,
  surfaceBindings,
  tenants,
  type DbHandle,
  type Embedder,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import { makeClassifyHandler } from '../classify-consumer';
import { makeSlackIntakeStateDeps } from '../classify-consumer/intake-state';
import { makeFakeClassifier } from '../engine/classify';

const suffix = randomUUID().slice(0, 8);
const stream = `test:classify-redaction:${suffix}`;
const deadStream = `${stream}:dead`;
const tenantId = randomUUID();
let admin: DbHandle;
let app: DbHandle;
let redis: Redis;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
  await admin.db.insert(tenants).values({ id: tenantId, name: 'classify payload redaction' });
});

afterAll(async () => {
  await redis?.del(stream, deadStream);
  if (admin) {
    await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(surfaceBindings).where(eq(surfaceBindings.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  await app?.close();
  await redis?.quit();
});

test('scrubs a provider payload before persisting the triage job', async () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwx1234';
  const externalId = `1788999999.${String(Date.now()).slice(-6)}`;
  const queue = new Queue(admin.db, redis, { stream, deadStream, group: `redaction-${suffix}` });
  const embedder: Embedder = {
    dim: EMBED_DIM,
    embed: async (texts) => texts.map(() => Array.from({ length: EMBED_DIM }, () => 0)),
  };
  const handler = makeClassifyHandler({
    classify: makeFakeClassifier(() => {
      throw new Error('invalid classifier response');
    }),
    appDb: app.db,
    redis,
    reservationRedis: redis,
    queue,
    hub: new ConversationHub(app.db, redis),
    embedder,
    ...makeSlackIntakeStateDeps(admin.db, admin.db),
  });

  await handler({
    id: randomUUID(),
    tenantId,
    type: 'classify',
    attempts: 1,
    payload: {
      externalId,
      channel: 'C_ALERTS',
      author: 'bot',
      text: `[FIRING] Pod is crash looping. ${secret}`,
      raw: {
        ts: externalId,
        text: `[FIRING] Pod is crash looping. ${secret}`,
        attachments: [{ text: `credential=${secret}` }],
      },
      signalState: 'firing',
      eventKey: `slack:C_ALERTS:${externalId}`,
      eventAt: new Date().toISOString(),
      contentHash: randomUUID(),
      isEdit: false,
      observations: [
        {
          externalMessageId: `${externalId}#0`,
          state: 'firing',
          summary: `Pod is crash looping. ${secret}`,
          contentHash: randomUUID(),
          eventKey: `provider:${externalId}`,
          eventAt: new Date().toISOString(),
          provider: 'prometheus-alertmanager',
          alertName: `Pod is crash looping. ${secret}`,
        },
      ],
    },
  });

  const [opened] = await admin.db
    .select({ id: incidents.id })
    .from(incidents)
    .where(sql`tenant_id = ${tenantId} and title = 'Pod is crash looping. [REDACTED]'`);
  expect(opened).toBeDefined();
  const [triageJob] = await admin.db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(
      sql`tenant_id = ${tenantId} and type = 'triage' and payload->>'incidentId' = ${opened!.id}`,
    );
  expect(triageJob).toBeDefined();
  expect(JSON.stringify(triageJob?.payload)).toContain('[REDACTED]');
  expect(JSON.stringify(triageJob?.payload)).not.toContain(secret);
});
