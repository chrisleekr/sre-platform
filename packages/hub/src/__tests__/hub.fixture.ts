import { seedMembership } from '@sre/db/test-support';
import {
  agentToolCalls,
  approvals,
  createIncident,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  investigationRuns,
  jobs,
  makeDb,
  memberships,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { ConversationHub } from '../hub';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

  let admin: DbHandle;

  let app: DbHandle;

  let redis: Redis;

  let hub: ConversationHub;

  let tenantA: string;

  let tenantB: string;

  let incidentId: string;

  // A real member of tenantA so the round-trip can stamp author_user_id with a valid user id
  // (author_user_id is a same-tenant composite FK to memberships, so a random uuid would RI-fail).
  const memberIdentityId = randomUUID();
  const MEMBER_IDENTITY = {
    issuer: 'https://test.idp.local/',
    subject: `sub|hub-c1-${memberIdentityId}`,
    email: `hub-c1-${memberIdentityId}@x.io`,
  };

  let memberUserId: string;

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
    hub = new ConversationHub(app.db, redis);
    tenantA = randomUUID();
    tenantB = randomUUID();
    await admin.db.insert(tenants).values([
      { id: tenantA, name: 'A' },
      { id: tenantB, name: 'B' },
    ]);
    incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'api',
        severity: 'sev2',
      })
    ).id;
    memberUserId = await seedMembership(admin.db, MEMBER_IDENTITY, tenantA);
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(agentToolCalls).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(jobs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(incidentMessages).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(incidentRelations).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(incidentSignals).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(investigationRuns).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      // approvals FK -> incidents (tenant-scoped), so clear approvals before the incidents delete.
      await admin.db.delete(approvals).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db
        .delete(users)
        .where(sql`issuer = ${MEMBER_IDENTITY.issuer} and subject = ${MEMBER_IDENTITY.subject}`);
      await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
      await admin.close();
    }
    if (app) await app.close();
    redis.disconnect();
  });

  return {
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
    get hub() {
      return hub;
    },
    set hub(value: typeof hub) {
      hub = value;
    },
    get tenantA() {
      return tenantA;
    },
    set tenantA(value: typeof tenantA) {
      tenantA = value;
    },
    get tenantB() {
      return tenantB;
    },
    set tenantB(value: typeof tenantB) {
      tenantB = value;
    },
    get incidentId() {
      return incidentId;
    },
    set incidentId(value: typeof incidentId) {
      incidentId = value;
    },
    MEMBER_IDENTITY,
    get memberUserId() {
      return memberUserId;
    },
    set memberUserId(value: typeof memberUserId) {
      memberUserId = value;
    },
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
