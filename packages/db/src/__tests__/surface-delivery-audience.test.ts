import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activateSurfaceBinding,
  createIncident,
  enqueueConnectedSurfaceDeliveriesTx,
  listMessageDeliveryTargets,
  makeDb,
  recordSurfaceBinding,
  upsertSurfaceConfig,
  withTenant,
  type DbHandle,
  type SurfaceDeliveryAudience,
} from '../index';
import {
  incidentMessages,
  incidents,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  tenants,
} from '../schema';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let incidentId: string;
let originalBindingId: string;
let activeBindingId: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Delivery audience tenant' });
  incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  await upsertSurfaceConfig(app.db, tenantId, { surface: 'slack' });
  originalBindingId = (
    await recordSurfaceBinding(app.db, tenantId, {
      incidentId,
      surface: 'slack',
      channel: 'C-AUDIENCE',
      threadId: 'original',
    })
  ).id;
  activeBindingId = (
    await recordSurfaceBinding(app.db, tenantId, {
      incidentId,
      surface: 'slack',
      channel: 'C-AUDIENCE',
      threadId: 'current',
      role: 'source',
    })
  ).id;
  await activateSurfaceBinding(app.db, tenantId, 'slack', incidentId, activeBindingId);
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(surfaceDeliveries).where(eq(surfaceDeliveries.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(surfaceBindings).where(eq(surfaceBindings.tenantId, tenantId));
    await admin.db.delete(surfaceConfigs).where(eq(surfaceConfigs.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

async function enqueue(
  kind: string,
  routing?: { audience: SurfaceDeliveryAudience; bindingId?: string },
): Promise<string> {
  return withTenant(app.db, tenantId, async (tx) => {
    const [message] = await tx
      .insert(incidentMessages)
      .values({ tenantId, incidentId, author: 'system', kind, content: kind })
      .returning({ id: incidentMessages.id });
    await enqueueConnectedSurfaceDeliveriesTx(
      tx,
      tenantId,
      incidentId,
      message!.id,
      kind,
      null,
      routing,
    );
    return message!.id;
  });
}

test('relationship events stay dashboard-only unless a caller targets a binding', async () => {
  const dashboardOnly = await enqueue('relationship');
  const targeted = await enqueue('relationship', {
    audience: 'specific_binding',
    bindingId: originalBindingId,
  });

  expect(await listMessageDeliveryTargets(app.db, tenantId, dashboardOnly)).toEqual([]);
  expect(await listMessageDeliveryTargets(app.db, tenantId, targeted)).toEqual([
    expect.objectContaining({ bindingId: originalBindingId }),
  ]);
});

test('current and status audiences have explicit, bounded destinations', async () => {
  const current = await enqueue('finding');
  const status = await enqueue('lifecycle');

  expect(await listMessageDeliveryTargets(app.db, tenantId, current)).toEqual([
    expect.objectContaining({ bindingId: activeBindingId }),
  ]);
  expect(
    (await listMessageDeliveryTargets(app.db, tenantId, status)).map((row) => row.bindingId),
  ).toEqual(expect.arrayContaining([originalBindingId, activeBindingId]));
  expect(await listMessageDeliveryTargets(app.db, tenantId, status)).toHaveLength(2);
});
