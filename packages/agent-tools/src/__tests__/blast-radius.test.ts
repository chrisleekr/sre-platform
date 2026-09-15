// Live-infra test (mirrors search-runbooks.test.ts): seeds a small graph as app_user under RLS
// (only the tenant row is inserted as admin) and runs the tool through runTool as app_user. Proves
// fetch_blast_radius exposes its stable name, defaults to the incident service, honours an explicit
// service override, and records exactly one audit entry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  services,
  serviceDependencies,
  upsertService,
  addDependency,
  type DbHandle,
} from '@sre/db';
import { makeFetchBlastRadiusTool } from '../blast-radius';
import { runTool } from '../dispatch';
import { makeInMemoryAuditSink } from '../audit';
import type { ToolContext } from '../types';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let app: DbHandle;
let admin: DbHandle;
let tenantId: string;
// A real tenant seeded with NO topology rows. RLS scopes the traversal to ctx.tenantId, so this is a
// genuinely empty topology store rather than a miss inside a populated one.
let emptyTenantId: string;
let tool: ReturnType<typeof makeFetchBlastRadiusTool>;

function makeCtx(audit: ToolContext['audit'], tenant = tenantId): ToolContext {
  return {
    tenantId: tenant,
    incidentId: randomUUID(),
    service: 'checkout',
    // Reads the topology store, not connectors; resolver is never called.
    resolveConnectors: () => Promise.resolve([]),
    audit,
  };
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  emptyTenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'A' });
  await admin.db.insert(tenants).values({ id: emptyTenantId, name: 'empty' });
  for (const name of ['web', 'checkout', 'ordersdb']) {
    await upsertService(app.db, tenantId, { name, team: 'core', criticality: 'tier1' });
  }
  await addDependency(app.db, tenantId, { upstream: 'web', downstream: 'checkout' });
  await addDependency(app.db, tenantId, { upstream: 'checkout', downstream: 'ordersdb' });
  tool = makeFetchBlastRadiusTool({ db: app.db });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(serviceDependencies).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(services).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${emptyTenantId}`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('makeFetchBlastRadiusTool', () => {
  it('exposes its stable tool name', () => {
    expect(tool.name).toBe('fetch_blast_radius');
  });

  it('defaults to the incident service and returns tiered dependents + suspects', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit), {});
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data.service).toBe('checkout');
    expect(result.data.mapped).toBe(true);
    expect(result.data.dependents.direct.map((d) => d.name)).toEqual(['web']);
    expect(result.data.suspects.map((s) => s.name)).toEqual(['ordersdb']);
  });

  it('honours an explicit service override', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit), { service: 'ordersdb' });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data.service).toBe('ordersdb');
    // The sync chain web -> checkout -> ordersdb means both hard-fail when ordersdb is down:
    // checkout at 1 hop, web transitively at 2 hops.
    expect(result.data.dependents.direct.map((d) => d.name)).toEqual(['checkout', 'web']);
    expect(result.data.suspects).toHaveLength(0);
  });

  it('records exactly one audit entry with outcome data', async () => {
    const audit = makeInMemoryAuditSink();
    await runTool(tool, makeCtx(audit), {});
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('data');
    expect(audit.records[0]!.tool).toBe('fetch_blast_radius');
  });

  // Characterization lock: empty is DATA, not unavailability. This tool reads the platform's own
  // topology store, so it is statically bound and always able to return data — an empty graph must
  // stay `available: true` with an empty radius, never an unavailable path. Guards the premise that
  // a tool reading a platform store has nothing to gate on.
  it('returns available:true with an empty blast radius on an empty store', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit, emptyTenantId), {});
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data.mapped).toBe(false);
    expect(result.data.dependents).toEqual({ direct: [], indirect: [], insulated: [] });
    expect(result.data.suspects).toEqual([]);
    // Empty still audits as a data outcome, not an error.
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('data');
  });
});

it('rejects environment-only input before querying a conversation identifier', async () => {
  const audit = makeInMemoryAuditSink();
  await expect(
    runTool(
      tool,
      { ...makeCtx(audit), service: 'slack:C-TOPOLOGY' },
      { environment: 'production' },
    ),
  ).rejects.toThrow('environment requires service or subjectKey');
  expect(audit.records).toEqual([]);
  expect(
    tool.inputSchema.safeParse({ service: 'checkout', environment: 'production' }).success,
  ).toBe(true);
  expect(
    tool.inputSchema.safeParse({ subjectKey: 'service-key', environment: 'production' }).success,
  ).toBe(true);
});
