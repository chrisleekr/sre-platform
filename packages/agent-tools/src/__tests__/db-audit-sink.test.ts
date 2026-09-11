// Live-infra test (mirrors knowledge-repo.test.ts / incident-repo.test.ts): the admin (superuser)
// role seeds the control-plane tenant + incident and cleans up; the sink runs as app_user so FORCE
// ROW LEVEL SECURITY binds. Proves the DB-backed audit sink persists a redacted, tenant-scoped row,
// that RLS isolates reads bidirectionally, and that the WITH CHECK policy rejects a forged insert.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  incidents,
  agentToolCalls,
  createIncident,
  withTenant,
  type DbHandle,
} from '@sre/db';
import { makeDbAuditSink } from '../db-audit-sink';

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
      alertSource: 'prometheus',
      service: 'billing',
      severity: 'sev3',
    })
  ).id;
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(agentToolCalls).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('makeDbAuditSink persistence + RLS', () => {
  it('persists a redacted row and isolates reads in both directions (RLS)', async () => {
    const sink = makeDbAuditSink({ db: app.db });
    const evidenceId = await sink.record({
      tool: 'datadog_search',
      tenantId: tenantA,
      incidentId: incidentA,
      // A secret in the input must never reach storage (CWE-532).
      input: { service: 'checkout', windowMinutes: 15, token: 'sk-secret-123' },
      latencyMs: 42,
      outcome: 'data',
    });

    // Before tenantB has a row of its own, RLS already hides tenantA's row from it.
    const rowsBEmpty = await withTenant(app.db, tenantB, (tx) => tx.select().from(agentToolCalls));
    expect(rowsBEmpty).toEqual([]);

    // tenantA reads its own row under RLS.
    const rowsA = await withTenant(app.db, tenantA, (tx) => tx.select().from(agentToolCalls));
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.id).toBe(evidenceId);
    expect(rowsA[0]!.tool).toBe('datadog_search');
    expect(rowsA[0]!.incidentId).toBe(incidentA);
    expect(rowsA[0]!.latencyMs).toBe(42);
    expect(rowsA[0]!.outcome).toBe('data');
    // The secret value is scrubbed; benign fields are intact.
    expect(rowsA[0]!.input).toEqual({
      service: 'checkout',
      windowMinutes: 15,
      token: '[REDACTED]',
    });

    // Seed a tenantB row, then assert isolation holds in BOTH directions.
    await sink.record({
      tool: 'datadog_query_metrics',
      tenantId: tenantB,
      incidentId: incidentB,
      input: { service: 'billing', windowMinutes: 5 },
      latencyMs: 7,
      outcome: 'error',
    });

    // tenantB sees only its own row, never tenantA's.
    const rowsB = await withTenant(app.db, tenantB, (tx) => tx.select().from(agentToolCalls));
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.tool).toBe('datadog_query_metrics');
    expect(rowsB[0]!.incidentId).toBe(incidentB);

    // tenantA still sees only its own row, never tenantB's (the other direction).
    const rowsA2 = await withTenant(app.db, tenantA, (tx) => tx.select().from(agentToolCalls));
    expect(rowsA2).toHaveLength(1);
    expect(rowsA2[0]!.incidentId).toBe(incidentA);
  });

  it('rejects a forged cross-tenant insert via the WITH CHECK policy (write isolation)', async () => {
    // Raw insert, not the sink (which stamps the session tenant): under tenantA's session, forge
    // tenantB's id. app_user holds INSERT and both FKs are satisfied (tenantB and incidentA exist),
    // so the rejection is the tenant_isolation WITH CHECK policy, not a privilege or FK error.
    await expect(
      withTenant(app.db, tenantA, (tx) =>
        tx.insert(agentToolCalls).values({
          tenantId: tenantB,
          incidentId: incidentA,
          tool: 'datadog_search',
          input: { forged: true },
          latencyMs: 1,
          outcome: 'data',
        }),
      ),
    ).rejects.toThrow();
  });
});
