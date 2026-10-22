// Live-Postgres two-tenant harness as in tool-call-repo.test.ts; the repo runs as app_user so RLS binds.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, createIncident, recordToolCall, type DbHandle } from '../index';
import { tenants, incidents, incidentMessages, agentToolCalls } from '../schema';
import * as toolCallRepo from '../tool-call-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let incidentA: string;
let incidentB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
  incidentA = (
    await createIncident(app.db, tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  incidentB = (
    await createIncident(app.db, tenantB, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(agentToolCalls).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidentMessages).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('incident evidence filters', () => {
  test('the data evidence filter keeps successful reads and drops error rows and other incidents', async () => {
    const call = { tool: 'filtered', input: { n: 2 }, latencyMs: 1 };
    const dataId = await recordToolCall(app.db, tenantB, {
      ...call,
      incidentId: incidentB,
      outcome: 'data',
      output: { v: 'good' },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });
    const errorId = await recordToolCall(app.db, tenantB, {
      ...call,
      incidentId: incidentB,
      outcome: 'error',
      output: { failure: 'not_found' },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });
    const proposed = [dataId, errorId, randomUUID()];

    await expect(
      toolCallRepo.filterIncidentDataEvidenceIds(app.db, tenantB, incidentB, proposed),
    ).resolves.toEqual([dataId]);
    await expect(
      toolCallRepo.filterIncidentEvidenceIds(app.db, tenantB, incidentB, proposed),
    ).resolves.toEqual(expect.arrayContaining([dataId, errorId]));
    await expect(
      toolCallRepo.filterIncidentDataEvidenceIds(app.db, tenantA, incidentA, proposed),
    ).resolves.toEqual([]);
  });
});
