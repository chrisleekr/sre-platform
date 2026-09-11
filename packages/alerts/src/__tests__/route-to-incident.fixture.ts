import {
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  makeDb,
  surfaceBindings,
  tenants,
  transitionIncidentTx,
  withTenant,
  type DbHandle,
  type Tx,
} from '@sre/db';
import { Queue } from '@sre/queue';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { type IncidentSignal } from '../route-to-incident';

export function createFixture() {
  /** Every signal now carries its origin conversation; this is the fixture one. */
  const origin = (channel: string, threadId: string): IncidentSignal['origin'] => ({
    surface: 'slack',
    channel,
    threadId,
  });

  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

  let admin: DbHandle;

  let app: DbHandle;

  let redis: Redis;

  let queue: Queue;

  let tenantId: string;

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
    queue = new Queue(admin.db, redis);
    tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'ALERTS' });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(jobs).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentMessages).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentSignals).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(surfaceBindings).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
      await admin.close();
    }
    if (app) await app.close();
    if (redis) await redis.quit();
  });

  const deps = () => ({ appDb: app.db, redis, queue });

  const setLifecycle = (incidentId: string, to: 'closed') =>
    withTenant(app.db, tenantId, (tx) => transitionIncidentTx(tx, incidentId, to));

  const depsWithOpener = () => ({
    ...deps(),
    appendOpenerTx: async (
      tx: Tx,
      openerTenantId: string,
      incidentId: string,
      opener: NonNullable<IncidentSignal['opener']>,
    ) => {
      const rows = await tx
        .insert(incidentMessages)
        .values({ tenantId: openerTenantId, incidentId, ...opener })
        .returning({ incidentId: incidentMessages.incidentId });
      return rows[0]!;
    },
  });

  return {
    origin,
    ADMIN_URL,
    APP_URL,
    VALKEY_URL,
    get admin() {
      return admin;
    },
    set admin(value: typeof admin) {
      admin = value;
    },
    get app() {
      return app;
    },
    set app(value: typeof app) {
      app = value;
    },
    get redis() {
      return redis;
    },
    set redis(value: typeof redis) {
      redis = value;
    },
    get queue() {
      return queue;
    },
    set queue(value: typeof queue) {
      queue = value;
    },
    get tenantId() {
      return tenantId;
    },
    set tenantId(value: typeof tenantId) {
      tenantId = value;
    },
    deps,
    setLifecycle,
    depsWithOpener,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
