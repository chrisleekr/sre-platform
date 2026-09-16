import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createIncident, makeDb, presentIncidentTitles, withTenant, type DbHandle } from '../index';
import { tenants, incidents, incidentMessages } from '../schema';

let admin: DbHandle;
let app: DbHandle;
const tenant = randomUUID();
const other = randomUUID();
beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values([
    { id: tenant, name: 'Title fixture' },
    { id: other, name: 'Other title fixture' },
  ]);
});
afterAll(async () => {
  await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenant));
  await admin.db.delete(incidents).where(eq(incidents.tenantId, tenant));
  await admin.db.delete(tenants).where(sql`id in (${tenant}, ${other})`);
  await app.close();
  await admin.close();
});
async function opening(request: string, context?: string) {
  const incident = await createIncident(app.db, tenant, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'slack:channel',
    severity: 'sev3',
    title: '<@U123456>',
  });
  const at = new Date();
  const origin = `slack:C:${incident.id}`;
  await withTenant(app.db, tenant, async (tx) => {
    await tx.insert(incidentMessages).values([
      {
        tenantId: tenant,
        incidentId: incident.id,
        author: 'human',
        kind: 'text',
        content: request,
        originMessageId: origin,
        createdAt: at,
      },
      {
        tenantId: tenant,
        incidentId: incident.id,
        author: 'system',
        kind: 'lifecycle',
        lifecycleVersion: 0,
        content: 'Incident open',
        createdAt: at,
      },
      ...(context
        ? [
            {
              tenantId: tenant,
              incidentId: incident.id,
              author: 'system',
              kind: 'status',
              content: `Prior Slack thread (context only):\n${context}`,
              originMessageId: `thread-context:${origin}`,
              createdAt: at,
            },
          ]
        : []),
    ]);
  });
  return { ...incident, title: '<@U123456>' };
}
test('derives opening task without rewriting stored title or returning the transcript', async () => {
  const row = await opening('<@U123456> Check cluster health?');
  const [result] = await presentIncidentTitles(app.db, tenant, [row]);
  expect(result).toMatchObject({
    title: '<@U123456>',
    displayTitle: 'Check cluster health?',
    titleSource: 'opening_request',
  });
  expect(result).not.toHaveProperty('content');
  expect((await admin.db.select().from(incidents).where(eq(incidents.id, row.id)))[0]?.title).toBe(
    '<@U123456>',
  );
});
test('uses exact linked root context and does not borrow later diagnostic claims', async () => {
  const row = await opening(
    '<@U123456>',
    '[UOTHER]: Checkout requests time out\n[UREPLY]: May be database saturation',
  );
  await withTenant(app.db, tenant, (tx) =>
    tx.insert(incidentMessages).values({
      tenantId: tenant,
      incidentId: row.id,
      author: 'human',
      content: 'Actually all services are down',
      createdAt: new Date(Date.now() + 60_000),
    }),
  );
  expect((await presentIncidentTitles(app.db, tenant, [row]))[0]).toMatchObject({
    displayTitle: 'Checkout requests time out',
    titleSource: 'opening_context',
  });
  expect((await presentIncidentTitles(app.db, other, [row]))[0]).toMatchObject({
    displayTitle: 'Opening context unavailable',
    titleSource: 'unavailable',
  });
});
test('distinguishes genuinely absent description from unavailable provenance', async () => {
  const row = await opening('<@U123456>');
  expect((await presentIncidentTitles(app.db, tenant, [row]))[0]?.titleSource).toBe('missing');
  const absent = await createIncident(app.db, tenant, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'slack:channel',
    severity: 'sev3',
    title: '<@U123456>',
  });
  expect(
    (await presentIncidentTitles(app.db, tenant, [{ ...absent, title: '<@U123456>' }]))[0]
      ?.titleSource,
  ).toBe('unavailable');
});
test('preserves useful titles and excludes arbitrary later messages from recovery', async () => {
  const row = await createIncident(app.db, tenant, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'slack:channel',
    severity: 'sev3',
    title: '<@U123456>',
  });
  await withTenant(app.db, tenant, async (tx) => {
    await tx.insert(incidentMessages).values(
      Array.from({ length: 12 }, (_, i) => ({
        tenantId: tenant,
        incidentId: row.id,
        author: 'human',
        content: `Unattributed reply ${i}`,
        createdAt: new Date(1_700_000_000_000 + i * 1000),
      })),
    );
  });
  expect(
    (await presentIncidentTitles(app.db, tenant, [{ ...row, title: '<@U123456>' }]))[0]
      ?.titleSource,
  ).toBe('unavailable');
  expect(
    (
      await presentIncidentTitles(app.db, tenant, [{ ...row, title: 'Possible database pressure' }])
    )[0]?.displayTitle,
  ).toBe('Possible database pressure');
});

test.each([2, 8])(
  'does not shift provenance boundaries past %i irrelevant opening messages',
  async (count) => {
    const row = await createIncident(app.db, tenant, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'slack:channel',
      severity: 'sev3',
    });
    const base = 1_700_000_000_000;
    await withTenant(app.db, tenant, async (tx) => {
      await tx.insert(incidentMessages).values(
        Array.from({ length: count }, (_, index) => ({
          tenantId: tenant,
          incidentId: row.id,
          author: 'agent',
          kind: 'reply',
          content: 'Irrelevant diagnostic content'.repeat(1000),
          createdAt: new Date(base + index * 1000),
        })),
      );
      await tx.insert(incidentMessages).values(
        count === 2
          ? [
              {
                tenantId: tenant,
                incidentId: row.id,
                author: 'human',
                kind: 'text',
                content:
                  'Human-initiated via @mention. Prior thread:\n[UROOT]: Later content must not become an opening title',
                createdAt: new Date(base + count * 1000),
              },
            ]
          : [
              {
                tenantId: tenant,
                incidentId: row.id,
                author: 'system',
                kind: 'lifecycle',
                lifecycleVersion: 0,
                content: 'Incident open',
                createdAt: new Date(base + count * 1000),
              },
              {
                tenantId: tenant,
                incidentId: row.id,
                author: 'human',
                kind: 'text',
                originMessageId: 'late-opener',
                content: 'Later content must not become an opening title',
                createdAt: new Date(base + count * 1000),
              },
            ],
      );
    });
    expect(
      (await presentIncidentTitles(app.db, tenant, [{ ...row, title: null }]))[0],
    ).toMatchObject({
      title: null,
      titleSource: 'unavailable',
    });
  },
);
