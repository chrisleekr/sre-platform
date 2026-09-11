// Live-infra test (mirrors slo-status.test.ts): seeds deployments as app_user under RLS (only the
// tenant row is inserted as admin) and runs the tool through runTool as app_user. Proves
// fetch_recent_deploys exposes its stable name, defaults to the incident service, honours an explicit
// service override, and records exactly one audit entry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, upsertDeployments, tenants, deployments, type DbHandle } from '@sre/db';
import { makeFetchRecentDeploysTool } from '../recent-deploys';
import { runTool } from '../dispatch';
import { makeInMemoryAuditSink } from '../audit';
import type { ToolContext } from '../types';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let app: DbHandle;
let admin: DbHandle;
let tenantId: string;
// A real tenant seeded with NO deployments. RLS scopes the read to ctx.tenantId, so this is a
// genuinely empty deploy store rather than a service that merely has no deploys.
let emptyTenantId: string;
let tool: ReturnType<typeof makeFetchRecentDeploysTool>;
const service = 'checkout';

function makeCtx(audit: ToolContext['audit'], tenant = tenantId): ToolContext {
  return {
    tenantId: tenant,
    incidentId: 'incident-1',
    service,
    // Reads the deployments store, not connectors; resolver is never called.
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

  // Two deploys for the incident service, plus a deploy for another service the default-service call
  // must NOT return.
  await upsertDeployments(app.db, tenantId, [
    {
      source: 'gitlab',
      repo: 'checkout',
      ref: 'main',
      sha: 'sha-checkout-old',
      service,
      status: 'success',
      deployedAt: new Date('2026-07-03T00:00:00Z'),
    },
    {
      source: 'gitlab',
      repo: 'checkout',
      ref: 'main',
      sha: 'sha-checkout-new',
      service,
      status: 'success',
      deployedAt: new Date('2026-07-03T01:00:00Z'),
    },
    {
      source: 'gitlab',
      repo: 'ordersdb',
      ref: 'main',
      sha: 'sha-orders',
      service: 'ordersdb',
      status: 'success',
      deployedAt: new Date('2026-07-03T02:00:00Z'),
    },
  ]);
  tool = makeFetchRecentDeploysTool({ db: app.db });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(deployments).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${emptyTenantId}`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('makeFetchRecentDeploysTool', () => {
  it('exposes its stable tool name', () => {
    expect(tool.name).toBe('fetch_recent_deploys');
  });

  it('defaults to the incident service and returns its deploys, newest first', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit), {});
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data).toHaveLength(2);
    // newest first
    expect(result.data[0]!.sha).toBe('sha-checkout-new');
    expect(result.data.every((d) => d.service === service)).toBe(true);
  });

  it('honours an explicit service override', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit), { service: 'ordersdb' });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.sha).toBe('sha-orders');
  });

  it('records exactly one audit entry with outcome data', async () => {
    const audit = makeInMemoryAuditSink();
    await runTool(tool, makeCtx(audit), {});
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('data');
    expect(audit.records[0]!.tool).toBe('fetch_recent_deploys');
  });

  // Characterization lock: empty is DATA, not unavailability. This tool reads the platform's own
  // deployments table (no live connector query), so it is statically bound and always able to return
  // data — an empty store must stay `available: true` with an empty list, never an unavailable path.
  it('returns available:true with an empty list on an empty store', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit, emptyTenantId), {});
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data).toEqual([]);
    // Empty still audits as a data outcome, not an error.
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('data');
  });
});
