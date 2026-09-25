import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  applySignalObservation,
  createIncident,
  incidentSignals,
  incidents,
  jobs,
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

  // Priority keys on mutable attention state, which a (created_at, id) keyset cannot follow.
  test('priority ordering neither returns nor accepts a cursor', async () => {
    const page = await incidentRepo.listIncidentsPage(__fixture.app.db, tenantK, {
      scope: 'closed',
      sort: 'priority',
      limit: 2,
    });
    expect(page.incidents).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    await expect(
      incidentRepo.listIncidentsPage(__fixture.app.db, tenantK, {
        scope: 'closed',
        sort: 'priority',
        limit: 2,
        before: { createdAt: new Date('2026-01-01T00:00:02.000Z'), id: uuidN(4) },
      }),
    ).rejects.toThrow('priority ordering does not support cursors');
  });

  // Every paginated ordering must walk the whole scope exactly once with its own keyset.
  test('pages oldest-first and severity orderings with no dup/skip', async () => {
    const cursors: incidentRepo.IncidentPageCursor[] = [];
    const readAll = async (sort: 'oldest' | 'severity', limit: number): Promise<string[]> => {
      const ids: string[] = [];
      let before: incidentRepo.IncidentPageCursor | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await incidentRepo.listIncidentsPage(__fixture.app.db, tenantK, {
          scope: 'closed',
          sort,
          limit,
          before,
        });
        ids.push(...page.incidents.map((row) => row.id));
        if (!page.nextCursor) return ids;
        cursors.push(page.nextCursor);
        before = page.nextCursor;
      }
      throw new Error('pagination did not terminate');
    };

    expect(await readAll('oldest', 2)).toEqual([...expectedOrder].reverse());

    // Severity leads, then newest within a severity: E and B are sev1, C stays sev2, and D and A
    // carry a severity outside the known set, so they share the unknown rank and sort last.
    await __fixture.admin.db
      .update(incidents)
      .set({ severity: 'sev1' })
      .where(sql`id in (${uuidN(5)}, ${uuidN(2)})`);
    await __fixture.admin.db
      .update(incidents)
      .set({ severity: 'critical' })
      .where(sql`id in (${uuidN(4)}, ${uuidN(1)})`);
    try {
      const severityOrder = [uuidN(5), uuidN(2), uuidN(3), uuidN(4), uuidN(1)];
      expect(await readAll('severity', 2)).toEqual(severityOrder);
      // Limit 1 breaks pages inside a severity level (E to B, D to A), so the same-rank keyset
      // branch runs, and the cursor after D carries the unknown rank back into the query.
      cursors.length = 0;
      expect(await readAll('severity', 1)).toEqual(severityOrder);
      expect(cursors.map((cursor) => cursor.severityRank)).toEqual([1, 1, 2, 99]);
    } finally {
      await __fixture.admin.db
        .update(incidents)
        .set({ severity: 'sev2' })
        .where(sql`tenant_id = ${tenantK}`);
    }
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
      await __fixture.admin.db.insert(jobs).values({
        tenantId: tCntA,
        type: 'triage',
        payload: { incidentId: automated },
        status: 'queued',
        stream: `count-automation-${randomUUID()}`,
      });
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
        .delete(jobs)
        .where(sql`tenant_id in (${tCntA}, ${tCntB}, ${tCntEmpty})`);
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
