import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  acceptSurfaceInboundEventTx,
  makeDb,
  surfaceConfigs,
  surfaceInboundEvents,
  tenants,
  withSurfaceInboundRoutingFence,
  type DbHandle,
} from '../index';

let admin: DbHandle;
let coordination: DbHandle;
const tenantId = randomUUID();
let configId: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  coordination = makeDb(process.env.DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'inbound identity test' });
  const rows = await admin.db
    .insert(surfaceConfigs)
    .values({ tenantId, surface: 'slack' })
    .returning({ id: surfaceConfigs.id });
  configId = rows[0]!.id;
});

afterAll(async () => {
  await admin.db.delete(surfaceInboundEvents).where(sql`tenant_id = ${tenantId}`);
  await admin.db.delete(surfaceConfigs).where(sql`tenant_id = ${tenantId}`);
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await coordination.close();
  await admin.close();
});

test('rejects legacy receipt identity mismatches before fenced routing', async () => {
  const cases = [
    {
      name: 'tenant',
      stored: { surface: 'slack', channel: 'C-identity', externalMessageId: 'message-identity' },
      input: { tenantId: randomUUID() },
      error: 'classify receipt not found',
    },
    {
      name: 'surface',
      stored: { surface: 'slack', channel: 'C-identity', externalMessageId: 'message-identity' },
      input: { surface: 'teams' },
      error: 'classify receipt surface does not match its candidate',
    },
    {
      name: 'channel',
      stored: { surface: 'slack', channel: 'C-stored', externalMessageId: 'message-identity' },
      input: { channel: 'C-candidate' },
      error: 'classify receipt channel does not match its candidate',
    },
    {
      name: 'message',
      stored: { surface: 'slack', channel: 'C-identity', externalMessageId: 'message-stored' },
      input: { externalMessageId: 'message-candidate' },
      error: 'classify receipt message does not match its candidate',
    },
  ];

  for (const scenario of cases) {
    const receipt = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId,
        configId,
        surface: scenario.stored.surface,
        deliveryKey: `event:identity-${scenario.name}-${randomUUID()}`,
        envelopeType: 'events_api',
        eventType: 'message',
        channel: scenario.stored.channel,
        externalMessageId: scenario.stored.externalMessageId,
      }),
    );
    const callback = vi.fn(async () => 'must-not-run');
    await expect(
      withSurfaceInboundRoutingFence(
        coordination.db,
        {
          tenantId,
          surface: 'slack',
          channel: 'C-identity',
          externalMessageId: 'message-identity',
          intakeId: receipt.row.id,
          eventAt: new Date('2026-08-29T00:00:20.000Z'),
          ...scenario.input,
        },
        callback,
      ),
    ).rejects.toThrow(scenario.error);
    expect(callback).not.toHaveBeenCalled();
    await expect(
      admin.db
        .select({
          surface: surfaceInboundEvents.surface,
          channel: surfaceInboundEvents.channel,
          externalMessageId: surfaceInboundEvents.externalMessageId,
        })
        .from(surfaceInboundEvents)
        .where(eq(surfaceInboundEvents.id, receipt.row.id)),
    ).resolves.toEqual([scenario.stored]);
  }
});
