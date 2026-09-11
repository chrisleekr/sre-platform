import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { createIncident, makeDb, type DbHandle } from '../index';
import {
  approvals,
  incidentMessages,
  incidents,
  surfaceBindings,
  surfaceConfigs,
  tenants,
} from '../schema';
import { type Surface } from '../surface-repo';

export function createFixture() {
  // A test-only second surface: the config listing/ordering/delete assertions need two
  // distinct surfaces. Cast at the boundary so the production Surface union stays 'slack' only; the repo
  // stores `surface` as plain text, so a non-slack label round-trips fine at runtime.
  const OTHER_SURFACE = 'teams' as Surface;

  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  let admin: DbHandle;

  let app: DbHandle;

  let tenantId: string;

  let incidentId: string;

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'SURF' });
    incidentId = (
      await createIncident(app.db, tenantId, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(approvals).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(surfaceBindings).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(surfaceConfigs).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentMessages).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
      await admin.close();
    }
    if (app) await app.close();
  });

  return {
    OTHER_SURFACE,
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
    get tenantId() {
      return tenantId;
    },
    set tenantId(value: typeof tenantId) {
      tenantId = value;
    },
    get incidentId() {
      return incidentId;
    },
    set incidentId(value: typeof incidentId) {
      incidentId = value;
    },
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
