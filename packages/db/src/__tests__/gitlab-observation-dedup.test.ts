import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { gitlabEvents, tenants } from '../schema';
import { makeDb, type DbHandle } from '../client';
import { withTenant } from '../rls';
import { recordGitLabEvent, recentGitLabEvents } from '../gitlab-repo';
import { changeSummary, listChangesPage } from '../change-repo';
import { gitLabRevisionKey } from '@sre/connectors';

let admin: DbHandle, app: DbHandle;
const tenantId = randomUUID(),
  connectorId = randomUUID(),
  otherConnectorId = randomUUID();
const at = new Date('2026-09-08T00:00:00Z');
const revision = gitLabRevisionKey('pipeline', '7', '42', 'success', at.toISOString())!;
const event = {
  eventType: 'pipeline',
  projectId: '7',
  projectFullPath: 'platform/service',
  action: 'success',
  summary: { id: 42, status: 'success' },
  occurredAt: at,
  observationKey: revision,
};

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Observation dedup test' });
});
afterAll(async () => {
  if (admin) {
    await admin.db.delete(gitlabEvents).where(eq(gitlabEvents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  await app?.close();
});

test('preserves receipts but displays one change for overlapping webhook and polling observations', async () => {
  expect(
    await recordGitLabEvent(app.db, tenantId, connectorId, { ...event, deliveryId: 'webhook-a' }),
  ).toBe(true);
  expect(
    await recordGitLabEvent(app.db, tenantId, connectorId, { ...event, deliveryId: 'webhook-b' }),
  ).toBe(true);
  expect(
    await recordGitLabEvent(app.db, tenantId, connectorId, {
      ...event,
      deliveryId: 'poll-state',
      summary: { ...event.summary, provenance: 'polling' },
    }),
  ).toBe(true);
  expect(
    await recordGitLabEvent(app.db, tenantId, connectorId, { ...event, deliveryId: 'webhook-a' }),
  ).toBe(false);
  expect(await withTenant(app.db, tenantId, (tx) => tx.select().from(gitlabEvents))).toHaveLength(
    3,
  );
  expect(
    await recentGitLabEvents(app.db, tenantId, connectorId, ['platform/service'], new Date(0)),
  ).toHaveLength(1);
  expect((await listChangesPage(app.db, tenantId)).changes).toHaveLength(1);
  expect(await changeSummary(app.db, tenantId, {})).toMatchObject({ total: 1, succeeded: 1 });
});

test('keeps connector identities isolated and retains unknown revisions and new state transitions', async () => {
  await recordGitLabEvent(app.db, tenantId, otherConnectorId, {
    ...event,
    deliveryId: 'other-source',
  });
  await recordGitLabEvent(app.db, tenantId, connectorId, {
    ...event,
    deliveryId: 'unknown-a',
    observationKey: undefined,
  });
  await recordGitLabEvent(app.db, tenantId, connectorId, {
    ...event,
    deliveryId: 'unknown-b',
    observationKey: undefined,
  });
  await recordGitLabEvent(app.db, tenantId, connectorId, {
    ...event,
    deliveryId: 'later',
    occurredAt: new Date(at.getTime() + 1000),
    observationKey: gitLabRevisionKey(
      'pipeline',
      '7',
      '42',
      'success',
      new Date(at.getTime() + 1000).toISOString(),
    ),
  });
  expect((await listChangesPage(app.db, tenantId)).changes).toHaveLength(5);
  expect((await listChangesPage(app.db, randomUUID())).changes).toEqual([]);
  const first = await listChangesPage(app.db, tenantId, { limit: 2 });
  const second = await listChangesPage(app.db, tenantId, { limit: 2, before: first.nextCursor! });
  const third = await listChangesPage(app.db, tenantId, { limit: 2, before: second.nextCursor! });
  expect(
    new Set([...first.changes, ...second.changes, ...third.changes].map((row) => row.id)).size,
  ).toBe(5);
});
