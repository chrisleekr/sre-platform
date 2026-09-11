import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  applySignalObservation,
  createIncident,
  incidentSignals,
  incidents,
  tenants,
} from '../index';

// active-set query + occurrence bump. Namespace access so a not-yet-exported symbol
// reads as `undefined` (a per-assertion RED: "not a function") instead of an ESM link error that
// would break the existing passing tests in this module.
import * as incidentRepo from '../incident-repo';

import { createFixture } from './incident-repo.fixture';

const __fixture = createFixture();

// closed-archive keyset pagination via `listIncidentsPage` (scope filter + (created_at, id) `before`
// cursor → { incidents, nextCursor }) so the dashboard can page the closed archive with no dup/skip.
// Mirrors the hub keyset test (hub.history.test.ts): explicit ids + created_at seeded via admin, incl.
// a created_at tie, then read back through the app conn (RLS). Isolated tenant so other tests' resolved
// incidents on tenantA cannot leak into the closed scope.
describe('listIncidents closed-archive keyset pagination', () => {
  let tenantK: string;
  const uuidN = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  // Expected (created_at desc, id desc) order across the closed set, incl. the t1 tie (C before B).
  const expectedOrder = [uuidN(5), uuidN(4), uuidN(3), uuidN(2), uuidN(1)];

  beforeAll(async () => {
    tenantK = randomUUID();
    await __fixture.admin.db.insert(tenants).values([{ id: tenantK, name: 'K' }]);
    const seed = (id: string, createdAt: string) =>
      __fixture.admin.db.insert(incidents).values({
        id,
        tenantId: tenantK,
        fingerprint: `k-${id}`,
        alertSource: 'datadog',
        service: 'api',
        severity: 'sev2',
        status: 'closed',
        createdAt: new Date(createdAt),
      });
    await seed(uuidN(1), '2026-01-01T00:00:00.000Z'); // A t0
    await seed(uuidN(2), '2026-01-01T00:00:01.000Z'); // B t1 (tie, smaller id)
    await seed(uuidN(3), '2026-01-01T00:00:01.000Z'); // C t1 (tie, larger id)
    await seed(uuidN(4), '2026-01-01T00:00:02.000Z'); // D t2
    await seed(uuidN(5), '2026-01-01T00:00:03.000Z'); // E t3
  });

  afterAll(async () => {
    await __fixture.admin.db.delete(incidents).where(sql`tenant_id = ${tenantK}`);
    await __fixture.admin.db.delete(tenants).where(sql`id = ${tenantK}`);
  });

  test('B3: pages the closed archive by (created_at, id) cursor with no dup/skip; nextCursor null on the last page', async () => {
    const page1 = await incidentRepo.listIncidentsPage(__fixture.app.db, tenantK, {
      scope: 'closed',
      limit: 2,
    });
    expect(page1.incidents).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await incidentRepo.listIncidentsPage(__fixture.app.db, tenantK, {
      scope: 'closed',
      limit: 2,
      before: page1.nextCursor!,
    });
    expect(page2.incidents).toHaveLength(2);

    const page3 = await incidentRepo.listIncidentsPage(__fixture.app.db, tenantK, {
      scope: 'closed',
      limit: 2,
      before: page2.nextCursor!,
    });
    expect(page3.incidents).toHaveLength(1);
    // Last page: fewer rows than the limit, so no further cursor.
    expect(page3.nextCursor).toBeNull();

    const ids = [...page1.incidents, ...page2.incidents, ...page3.incidents].map((r) => r.id);
    expect(ids).toEqual(expectedOrder); // deterministic order incl. the t1 tie (C before B)
    expect(new Set(ids).size).toBe(5); // no duplicate across pages
  });

  // countIncidentsByScope backs the dashboard tab badges: it must return lifecycle and attention totals
  // under RLS. Fresh tenants keep the assertions exact regardless of other tests in this file.
  test('countIncidentsByScope returns tenant-scoped lifecycle and attention totals', async () => {
    const tCntA = randomUUID();
    const tCntB = randomUUID();
    const tCntEmpty = randomUUID();
    await __fixture.admin.db.insert(tenants).values([
      { id: tCntA, name: 'cntA' },
      { id: tCntB, name: 'cntB' },
      { id: tCntEmpty, name: 'cntEmpty' },
    ]);
    try {
      const seedStatus = async (
        tenant: string,
        status: 'open' | 'mitigated' | 'resolved' | 'closed',
        severity = 'sev2',
      ): Promise<string> => {
        const { id } = await createIncident(__fixture.app.db, tenant, {
          fingerprint: `c-${randomUUID()}`,
          alertSource: 'datadog',
          service: 'api',
          severity,
        });
        await __fixture.admin.db.update(incidents).set({ status }).where(eq(incidents.id, id));
        return id;
      };
      // tCntA: one automation-owned sev3, one active mitigation, and three terminal rows.
      const automated = await seedStatus(tCntA, 'open', 'sev3');
      await applySignalObservation(__fixture.app.db, tCntA, {
        incidentId: automated,
        surface: 'slack',
        channel: 'C-counts',
        externalMessageId: `count-${randomUUID()}`,
        state: 'firing',
        summary: 'Tracked sev3 signal',
        contentHash: randomUUID(),
        eventKey: `count-${randomUUID()}`,
        eventAt: new Date(),
      });
      await seedStatus(tCntA, 'mitigated');
      await seedStatus(tCntA, 'resolved');
      await seedStatus(tCntA, 'resolved');
      await seedStatus(tCntA, 'closed');
      // tCntB: unrelated rows that must NOT leak into tCntA's counts.
      await seedStatus(tCntB, 'open');
      await seedStatus(tCntB, 'closed');

      expect(await incidentRepo.countIncidentsByScope(__fixture.app.db, tCntA)).toEqual({
        all: 5,
        open: 2,
        needsHuman: 1,
        automation: 1,
        closed: 3,
      });
      // RLS: each tenant counts only its own rows.
      expect(await incidentRepo.countIncidentsByScope(__fixture.app.db, tCntB)).toEqual({
        all: 2,
        open: 1,
        needsHuman: 1,
        automation: 0,
        closed: 1,
      });
      // Empty tenant exercises every `?? 0` path.
      expect(await incidentRepo.countIncidentsByScope(__fixture.app.db, tCntEmpty)).toEqual({
        all: 0,
        open: 0,
        needsHuman: 0,
        automation: 0,
        closed: 0,
      });
    } finally {
      await __fixture.admin.db
        .delete(incidentSignals)
        .where(sql`tenant_id in (${tCntA}, ${tCntB}, ${tCntEmpty})`);
      await __fixture.admin.db
        .delete(incidents)
        .where(sql`tenant_id in (${tCntA}, ${tCntB}, ${tCntEmpty})`);
      await __fixture.admin.db.delete(tenants).where(sql`id in (${tCntA}, ${tCntB}, ${tCntEmpty})`);
    }
  });
});
