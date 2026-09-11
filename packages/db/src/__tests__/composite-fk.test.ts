// Cross-tenant FK hardening (pattern). incident_messages.incident_id and
// agent_tool_calls.incident_id must be composite (tenant_id, incident_id) -> incidents(tenant_id, id)
// FKs, not plain incident_id FKs. Referential-integrity checks bypass RLS, so a plain FK lets tenant A
// reference/probe tenant B's incident (a cross-tenant existence oracle). These tests seed an incident
// under tenant B, then prove tenant A CANNOT create a child row pointing at it, while the same-tenant
// insert still succeeds (the composite FK must not break the legitimate path).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, createIncident, withTenant, recordToolCall, type DbHandle } from '../index';
import { tenants, incidents, incidentMessages, agentToolCalls } from '../schema';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
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

// 23503 = foreign_key_violation. Asserting the code (not just any throw) proves the rejection is
// the composite FK, not an incidental error. drizzle wraps DB errors so the SQLSTATE is on
// `.cause.code`; fall back to `.code` for an unwrapped driver error (matches topology.ts).
async function expectForeignKeyViolation(run: Promise<unknown>): Promise<void> {
  let err: { code?: string; cause?: { code?: string } } | undefined;
  try {
    await run;
  } catch (e) {
    err = e as typeof err;
  }
  expect(err, 'expected the cross-tenant insert to be rejected').toBeDefined();
  expect(err?.code ?? err?.cause?.code).toBe('23503');
}

describe('composite same-tenant FK on incident children', () => {
  test('incident_messages: tenant A cannot reference tenant B incident', async () => {
    await expectForeignKeyViolation(
      withTenant(app.db, tenantA, (tx) =>
        tx
          .insert(incidentMessages)
          .values({ tenantId: tenantA, incidentId: incidentB, author: 'human', content: 'probe' }),
      ),
    );
  });

  test('agent_tool_calls: tenant A cannot reference tenant B incident', async () => {
    await expectForeignKeyViolation(
      recordToolCall(app.db, tenantA, {
        incidentId: incidentB,
        tool: 'blast_radius',
        input: {},
        latencyMs: 1,
        outcome: 'data',
      }),
    );
  });

  test('same-tenant child inserts still succeed (composite FK must not break the legit path)', async () => {
    await withTenant(app.db, tenantB, (tx) =>
      tx
        .insert(incidentMessages)
        .values({ tenantId: tenantB, incidentId: incidentB, author: 'human', content: 'ok' }),
    );
    const id = await recordToolCall(app.db, tenantB, {
      incidentId: incidentB,
      tool: 'blast_radius',
      input: {},
      latencyMs: 1,
      outcome: 'data',
    });
    expect(id).toBeTruthy();
  });
});
