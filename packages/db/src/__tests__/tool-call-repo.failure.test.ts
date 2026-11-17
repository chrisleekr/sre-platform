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

describe('evidence failure category', () => {
  test('exposes only the classified failure of a failed check', async () => {
    const record = (outcome: 'data' | 'error', output?: unknown) =>
      recordToolCall(app.db, tenantA, {
        incidentId: incidentA,
        tool: 'statuscake_get_test',
        input: { id: '5' },
        latencyMs: 1,
        outcome,
        output,
      } as Parameters<typeof recordToolCall>[2]);
    const failed = await record('error', { failure: 'not_found' });
    const dataRow = await record('data', { failure: 'not_found', rows: [] });
    const bare = await record('error');

    const page = await toolCallRepo.listIncidentEvidencePage(app.db, tenantA, incidentA, {
      limit: 100,
    });
    const failureOf = (id: string) => page.evidence.find((row) => row.id === id)?.failure;
    expect(failureOf(failed)).toBe('not_found');
    expect(failureOf(dataRow)).toBeNull();
    expect(failureOf(bare)).toBeNull();

    const detail = await toolCallRepo.getIncidentEvidence(app.db, tenantA, incidentA, failed);
    expect(detail?.failure).toBe('not_found');
    expect(page.evidence.find((row) => row.id === failed)?.summary).toBe('id: 5');
    expect(await toolCallRepo.getIncidentEvidence(app.db, tenantB, incidentA, failed)).toBeNull();

    expect(
      (await toolCallRepo.listIncidentEvidencePage(app.db, tenantB, incidentA)).evidence,
    ).toEqual([]);
  });
});
