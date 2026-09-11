import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  acceptSurfaceInboundEventTx,
  makeDb,
  surfaceInboundEvents,
  tenants,
  type DbHandle,
} from '@sre/db';
import { makeSlackIntakeStateDeps } from '../classify-consumer/intake-state';

let admin: DbHandle;
const tenantId = randomUUID();
const intakeIds: string[] = [];

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'classification outcome reasons' });
});

afterAll(async () => {
  if (!admin) return;
  await admin.db.delete(surfaceInboundEvents).where(inArray(surfaceInboundEvents.id, intakeIds));
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await admin.close();
});

test.each(['provider_unavailable', 'classifier_error'] as const)(
  'persists the safe %s fail-open reason through the production intake bridge',
  async (reason) => {
    const receipt = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId,
        surface: 'slack',
        deliveryKey: `classification-reason:${reason}:${randomUUID()}`,
        envelopeType: 'events_api',
        eventType: 'message',
        channel: 'C-alerts',
        externalMessageId: randomUUID(),
      }),
    );
    intakeIds.push(receipt.row.id);
    const state = makeSlackIntakeStateDeps(admin.db, admin.db);

    await state.onOutcome?.({
      intakeId: receipt.row.id,
      tenantId,
      channel: 'C-alerts',
      messageId: receipt.row.externalMessageId!,
      author: 'bot',
      outcome: 'fail_open',
      attempts: 5,
      reason,
    });

    const [persisted] = await admin.db
      .select({
        classificationOutcome: surfaceInboundEvents.classificationOutcome,
        errorCode: surfaceInboundEvents.errorCode,
      })
      .from(surfaceInboundEvents)
      .where(eq(surfaceInboundEvents.id, receipt.row.id));
    expect(persisted).toEqual({ classificationOutcome: 'fail_open', errorCode: reason });
  },
);
