import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import {
  agentToolCalls,
  approvals,
  inboundChannels,
  inboundSideEffects,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  jobs,
  makeDb,
  surfaceBindings,
  tenants,
  transitionIncidentTx,
  withTenant,
  type DbHandle,
} from '../index';
// active-set query + occurrence bump. Namespace access so a not-yet-exported symbol
// reads as `undefined` (a per-assertion RED: "not a function") instead of an ESM link error that
// would break the existing passing tests in this module.

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  let admin: DbHandle;

  let app: DbHandle;

  let tenantA: string;

  let tenantB: string;

  const setLifecycle = (
    db: DbHandle['db'],
    tenantId: string,
    id: string,
    status: 'open' | 'mitigated' | 'resolved' | 'closed',
  ) => withTenant(db, tenantId, (tx) => transitionIncidentTx(tx, id, status));

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    tenantA = randomUUID();
    tenantB = randomUUID();
    await admin.db.insert(tenants).values([
      { id: tenantA, name: 'A' },
      { id: tenantB, name: 'B' },
    ]);
  });

  afterAll(async () => {
    if (admin) {
      // Delete incident_messages first: degradeIncidentWithMessages inserts them, and the FK to
      // incidents blocks deleting the parent otherwise.
      await admin.db.delete(agentToolCalls).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(jobs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(incidentMessages).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(incidentRelations).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(surfaceBindings).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(inboundChannels).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      // The occurrence-bump ledger FKs (tenant_id, incident_id) -> incidents, so it goes before the parent.
      await admin.db.delete(inboundSideEffects).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(incidentSignals).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(approvals).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
      await admin.close();
    }
    if (app) await app.close();
  });

  return {
    ADMIN_URL,
    APP_URL,
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
    setLifecycle,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
