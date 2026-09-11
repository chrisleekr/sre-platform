// `fetch_slo_status` reads the platform's own SLO tables and the latest persisted burn event.
// Like fetch_recent_deploys it queries no live connector, so it is a PLATFORM tool: statically bound
// and always able to answer. Live infra (mirrors recent-deploys.test.ts): seeds as app_user under RLS
// and runs through runTool, so tenant scoping here is the real policy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, createSlo, recordBurnEvent, tenants, slos, type Db, type DbHandle } from '@sre/db';
import { makeFetchSloStatusTool } from '../slo-status';
import { runTool } from '../dispatch';
import { makeInMemoryAuditSink } from '../audit';
import type { ToolContext } from '../types';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

// This suite is about the tool, not the per-tenant ceiling, so it creates under a cap it never reaches.
const SLO_CAP = 1_000;

let app: DbHandle;
let admin: DbHandle;
let tenantId: string;
// A real tenant with no SLOs at all: RLS scopes the read to ctx.tenantId, so this is a genuinely
// empty store rather than a service that merely has none.
let emptyTenantId: string;
let tool: ReturnType<typeof makeFetchSloStatusTool>;
const service = 'checkout';

function makeCtx(audit: ToolContext['audit'], tenant = tenantId): ToolContext {
  return {
    tenantId: tenant,
    incidentId: 'incident-1',
    service,
    // Reads the platform's own tables, not connectors; the resolver is never called.
    resolveConnectors: () => Promise.resolve([]),
    audit,
  };
}

const newSlo = (svc: string, name: string) => ({
  name,
  service: svc,
  sliType: 'availability' as const,
  target: 0.999,
  windowDays: 30,
  metricQuery: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
  connectorType: 'prometheus',
});

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  emptyTenantId = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantId, name: 'SLO-TOOL' },
    { id: emptyTenantId, name: 'SLO-TOOL-EMPTY' },
  ]);

  const evaluated = await createSlo(
    app.db,
    tenantId,
    newSlo(service, 'checkout-availability'),
    SLO_CAP,
  );
  await recordBurnEvent(app.db, tenantId, {
    sloId: evaluated.id,
    budgetPct: 0.25,
    burnRate: 4,
    window: '1h',
  });
  // A second service the default-service call must NOT return, and it is unevaluated on purpose.
  await createSlo(app.db, tenantId, newSlo('ordersdb', 'orders-availability'), SLO_CAP);

  tool = makeFetchSloStatusTool({ db: app.db });
}, 30_000);

afterAll(async () => {
  if (admin) {
    // Burn events cascade off their objective.
    await admin.db.delete(slos).where(sql`tenant_id in (${tenantId}, ${emptyTenantId})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantId}, ${emptyTenantId})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('makeFetchSloStatusTool', () => {
  it('exposes its stable tool name', () => {
    expect(tool.name).toBe('fetch_slo_status');
  });

  it('defaults to the incident service and returns budget, burn and projection', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit), {});

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.name).toBe('checkout-availability');
    expect(result.data[0]!.service).toBe(service);
    expect(result.data[0]!.evaluation!.budgetRemaining).toBeCloseTo(0.25, 9);
    expect(result.data[0]!.evaluation!.burnRate).toBeCloseTo(4, 9);
    expect(result.data[0]!.evaluation!.burnWindow).toBe('1h');
    // 0.25 * 30 / 4, projected on read rather than stored.
    expect(result.data[0]!.evaluation!.exhaustionDays).toBeCloseTo(1.875, 6);
  });

  it('honours an explicit service override and reports an unevaluated objective as null', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit), { service: 'ordersdb' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.name).toBe('orders-availability');
    // No burn event yet: the tool reports the absence rather than fabricating a budget.
    expect(result.data[0]!.evaluation).toBe(null);
  });

  it('records exactly one audit entry with outcome data', async () => {
    const audit = makeInMemoryAuditSink();
    await runTool(tool, makeCtx(audit), {});

    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.tool).toBe('fetch_slo_status');
    expect(audit.records[0]!.outcome).toBe('data');
  });

  it('returns available:true with an empty list on a tenant that has defined no objectives', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit, emptyTenantId), {});

    // Emptiness is a first-class value here, never a distinct "nothing yet" outcome.
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data).toEqual([]);
    expect(audit.records[0]!.outcome).toBe('data');
  });

  it('degrades a read failure to a secret-free error result rather than rejecting the run', async () => {
    const audit = makeInMemoryAuditSink();
    const broken = makeFetchSloStatusTool({ db: {} as unknown as Db });

    const result = await runTool(broken, makeCtx(audit), {});

    expect(result.available).toBe(false);
    if (result.available) throw new Error('expected an error result');
    expect(result.reason).toBe('error');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('error');
    // No error detail is carried to the engine: raw failure text could leak credentials.
    expect(JSON.stringify(result)).not.toMatch(/postgres|password|transaction is not a function/i);
  });
});
