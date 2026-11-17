import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import {
  createIncident,
  incidentRelations,
  incidents,
  listIncidentsPage,
  makeDb,
  recordIncidentRelation,
  tenants,
  type DbHandle,
} from '..';

let admin: DbHandle;
let app: DbHandle;
const tenantIds: string[] = [];

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentRelations).where(inArray(incidentRelations.tenantId, tenantIds));
    await admin.db.delete(incidents).where(inArray(incidents.tenantId, tenantIds));
    await admin.db.delete(tenants).where(inArray(tenants.id, tenantIds));
    await admin.close();
  }
  if (app) await app.close();
});

type Status = 'open' | 'closed';

/**
 * Chain e1 <- e2 <- e3: each newer episode is a recurrence_of the previous one. Creation times are
 * a minute apart because created_at has millisecond precision and a tie would make "newer" depend
 * on random ids.
 */
async function chain(statuses: [Status, Status, Status]) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Recurrence list' });
  const ids: string[] = [];
  const base = Date.now() - 3_600_000;
  for (const [i, status] of statuses.entries()) {
    const { id } = await createIncident(app.db, tenantId, {
      fingerprint: `recurrence-list-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
      title: `Checkout episode ${i + 1}`,
    });
    await admin.db
      .update(incidents)
      .set({ status, createdAt: new Date(base + i * 60_000) })
      .where(eq(incidents.id, id));
    ids.push(id);
  }
  const link = (source: string, target: string) =>
    recordIncidentRelation(app.db, tenantId, {
      sourceIncidentId: source,
      targetIncidentId: target,
      type: 'recurrence_of',
      rationale: 'Same monitor.',
      evidence: [],
      decidedBy: 'system',
    });
  await link(ids[1]!, ids[0]!);
  await link(ids[2]!, ids[1]!);
  const [e1, e2, e3] = ids as [string, string, string];
  const list = async (opts: Parameters<typeof listIncidentsPage>[2]) =>
    (await listIncidentsPage(app.db, tenantId, opts)).incidents;
  const listedIds = async (opts: Parameters<typeof listIncidentsPage>[2]) =>
    new Set((await list(opts)).map((row) => row.id));
  const createdAt = async (id: string) =>
    (await admin.db.select().from(incidents).where(eq(incidents.id, id)))[0]!.createdAt.getTime();
  const byId = async (opts: Parameters<typeof listIncidentsPage>[2]) =>
    new Map((await list(opts)).map((row) => [row.id, row]));
  return { e1, e2, e3, link, list, listedIds, createdAt, byId };
}

const sinceMs = (row: { recurrence: { since: string } | null } | undefined) =>
  row?.recurrence ? new Date(row.recurrence.since).getTime() : null;

test('closed older episodes hide behind the newest episode in the same tab', async () => {
  const { e1, e2, e3, list, listedIds, createdAt, byId } = await chain([
    'closed',
    'closed',
    'open',
  ]);
  expect(await listedIds({ scope: 'closed' })).toEqual(new Set([e2]));
  const closedRow = (await byId({ scope: 'closed' })).get(e2);
  expect(closedRow!.recurrence!.earlierEpisodes).toBe(1);
  expect(sinceMs(closedRow)).toBe(await createdAt(e1));
  expect(await listedIds({ scope: 'all' })).toEqual(new Set([e3]));
  const [row, ...rest] = await list({ scope: 'open' });
  expect(rest).toEqual([]);
  expect(row!.id).toBe(e3);
  expect(row!.recurrence!.earlierEpisodes).toBe(2);
  expect(sinceMs(row)).toBe(await createdAt(e1));
});

test('a search or severity filter lists every episode', async () => {
  const { e1, e2, e3, listedIds, byId } = await chain(['closed', 'closed', 'open']);
  const all = new Set([e1, e2, e3]);
  expect(await listedIds({ scope: 'all', query: 'Checkout episode' })).toEqual(all);
  expect(await listedIds({ scope: 'all', severity: 'sev2' })).toEqual(all);
  const rows = await byId({ scope: 'all', query: 'Checkout episode' });
  expect(rows.get(e1)!.recurrence).toBeNull();
});

test('an open earlier episode is never hidden', async () => {
  const { e2, e3, listedIds } = await chain(['closed', 'open', 'open']);
  expect(await listedIds({ scope: 'open' })).toEqual(new Set([e2, e3]));
  expect(await listedIds({ scope: 'all' })).toEqual(new Set([e2, e3]));
});

test('a superseded relation does not hide', async () => {
  const { e1, e2, e3, listedIds, createdAt, byId } = await chain(['closed', 'closed', 'open']);
  await admin.db
    .update(incidentRelations)
    .set({ supersededAt: new Date() })
    .where(eq(incidentRelations.sourceIncidentId, e2));
  expect(await listedIds({ scope: 'closed' })).toEqual(new Set([e1, e2]));
  const row = (await byId({ scope: 'open' })).get(e3);
  expect(row!.recurrence!.earlierEpisodes).toBe(1);
  expect(sinceMs(row)).toBe(await createdAt(e2));
});

test('an archived newer episode does not hide the one it recurs from', async () => {
  const { e1, e2, e3, listedIds, createdAt, byId } = await chain(['closed', 'closed', 'open']);
  await admin.db.update(incidents).set({ archivedAt: new Date() }).where(eq(incidents.id, e2));
  expect(await listedIds({ scope: 'closed' })).toEqual(new Set([e1]));
  expect(await listedIds({ scope: 'all' })).toEqual(new Set([e1, e3]));
  const row = (await byId({ scope: 'all' })).get(e3);
  expect(row!.recurrence!.earlierEpisodes).toBe(1);
  expect(sinceMs(row)).toBe(await createdAt(e1));
});

test('a link from an older episode to a newer one neither hides nor counts the newer one', async () => {
  const { e1, e2, e3, link, listedIds, byId } = await chain(['closed', 'closed', 'closed']);
  await admin.db
    .delete(incidentRelations)
    .where(inArray(incidentRelations.sourceIncidentId, [e2, e3]));
  await link(e1, e2);
  expect(await listedIds({ scope: 'all' })).toEqual(new Set([e1, e2, e3]));
  const rows = await byId({ scope: 'all' });
  expect(rows.get(e1)!.recurrence).toBeNull();
  expect(rows.get(e2)!.recurrence).toBeNull();
});

test('a link cycle terminates and lists its newest member without counting it twice', async () => {
  const { e1, e3, link, list, createdAt } = await chain(['closed', 'closed', 'closed']);
  await link(e1, e3);
  const [row, ...rest] = await list({ scope: 'closed' });
  expect(rest).toEqual([]);
  expect(row!.id).toBe(e3);
  expect(row!.recurrence!.earlierEpisodes).toBe(2);
  expect(sinceMs(row)).toBe(await createdAt(e1));
});
