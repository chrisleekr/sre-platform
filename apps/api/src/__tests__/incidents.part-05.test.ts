import { seedMembership } from '@sre/db/test-support';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  applySignalObservation,
  createIncident,
  inboundChannels,
  incidentSignals,
  incidents,
  jobs,
  memberships,
  recordSurfaceBinding,
  subscribeChannel,
  surfaceBindings,
  tenantIdentityBindings,
  tenants,
  users,
} from '@sre/db';

import { IncidentUnavailableError } from '@sre/queue';

import { createFixture } from './incidents.fixture';
import { bindTestIdentity } from './auth-test-support';

const __fixture = createFixture();

test('returns queued responder work independently of the active job', async () => {
  const id = __fixture.runbookIncidentId;
  const inserted = await __fixture.admin.db
    .insert(jobs)
    .values([
      {
        tenantId: __fixture.tenantC,
        type: 'triage',
        status: 'processing',
        stream: 'test',
        payload: { incidentId: id },
      },
      {
        tenantId: __fixture.tenantC,
        type: 'resume',
        status: 'queued',
        stream: 'test',
        payload: { incidentId: id },
      },
    ])
    .returning({ id: jobs.id });
  try {
    const response = await __fixture.api.request(
      `/incidents/${id}`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pendingAutomation: { type: 'triage', status: 'processing' },
      queuedResponderWork: { type: 'resume', status: 'queued' },
    });
  } finally {
    for (const item of inserted) await __fixture.admin.db.delete(jobs).where(eq(jobs.id, item.id));
  }
});

// server-side open/closed scope filtering + true per-scope counts on GET /incidents. RED now: the
// route ignores `?state` entirely (only `?status` is handled, B5) and carries no counts. A dedicated
// tenant D with a known status mix keeps these independent of the shared A/B/C fixtures and their
// exact-length assertions above.
describe('GET /incidents?state= scope filter + counts', () => {
  let orgD: string;
  let tenantD: string;
  let openIds: string[];
  let closedIds: string[];
  let archivedId: string;
  let automatedId: string;
  const OPEN_SCOPE = new Set(['open', 'mitigated']);
  const CLOSED_SCOPE = new Set(['resolved', 'closed']);

  beforeAll(async () => {
    orgD = `org_${randomUUID().slice(0, 8)}`;
    tenantD = randomUUID();
    await __fixture.admin.db.insert(tenants).values([{ id: tenantD, name: 'D' }]);
    await seedMembership(__fixture.admin.db, { issuer: __fixture.ISSUER, subject: orgD }, tenantD);
    await bindTestIdentity({
      adminDb: __fixture.admin.db,
      issuer: __fixture.ISSUER,
      tenantId: tenantD,
      subject: orgD,
    });

    const mk = async (
      svc: string,
      severity = 'sev2',
      extra: { alertSource?: string; title?: string } = {},
    ) =>
      (
        await createIncident(__fixture.app.db, tenantD, {
          fingerprint: `d-${randomUUID()}`,
          alertSource: extra.alertSource ?? 'datadog',
          service: svc,
          severity,
          title: extra.title,
        })
      ).id;
    const idOpen = await mk('svc-open', 'sev3', {
      alertSource: 'prometheus-special',
      title: 'Checkout latency search marker',
    });
    automatedId = idOpen;
    await subscribeChannel(__fixture.app.db, {
      tenantId: tenantD,
      surface: 'slack',
      channel: 'C-search-scope',
      channelName: 'incident-search-channel',
    });
    await recordSurfaceBinding(__fixture.app.db, tenantD, {
      incidentId: idOpen,
      surface: 'slack',
      channel: 'C-search-scope',
      threadId: `scope-${randomUUID()}`,
    });
    await applySignalObservation(__fixture.app.db, tenantD, {
      incidentId: idOpen,
      surface: 'slack',
      channel: 'C-scope-test',
      externalMessageId: `scope-${randomUUID()}`,
      state: 'firing',
      summary: 'Tracked sev3 alert',
      contentHash: randomUUID(),
      eventKey: `scope-${randomUUID()}`,
      eventAt: new Date(),
    });
    const idMitigated = await mk('svc-mitigated');
    const idRes = await mk('svc-res');
    const idClosed = await mk('svc-closed');
    archivedId = await mk('svc-archived');
    const setStatus = (id: string, status: 'open' | 'mitigated' | 'resolved' | 'closed') =>
      __fixture.admin.db
        .update(incidents)
        .set({ status })
        .where(sql`id = ${id}`);
    await setStatus(idMitigated, 'mitigated');
    await setStatus(idRes, 'resolved');
    await setStatus(idClosed, 'closed');
    await __fixture.admin.db
      .update(incidents)
      .set({ status: 'closed', archivedAt: new Date('2026-08-20T00:00:00.000Z') })
      .where(eq(incidents.id, archivedId));
    openIds = [idOpen, idMitigated];
    closedIds = [idRes, idClosed];
  }, 30_000);

  afterAll(async () => {
    await __fixture.admin.db.delete(incidentSignals).where(sql`tenant_id = ${tenantD}`);
    await __fixture.admin.db.delete(surfaceBindings).where(sql`tenant_id = ${tenantD}`);
    await __fixture.admin.db.delete(inboundChannels).where(sql`tenant_id = ${tenantD}`);
    await __fixture.admin.db.delete(incidents).where(sql`tenant_id = ${tenantD}`);
    await __fixture.admin.db.delete(memberships).where(sql`tenant_id = ${tenantD}`);
    await __fixture.admin.db.delete(tenantIdentityBindings).where(sql`tenant_id = ${tenantD}`);
    await __fixture.admin.db
      .delete(users)
      .where(sql`issuer = ${__fixture.ISSUER} and subject = ${orgD}`);
    await __fixture.admin.db.delete(tenants).where(sql`id = ${tenantD}`);
  });

  test('B1: ?state=open returns only open|mitigated', async () => {
    const res = await __fixture.api.request(
      '/incidents?state=open',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidents: Array<{ id: string; status: string }> };
    expect(body.incidents.every((i) => OPEN_SCOPE.has(i.status))).toBe(true);
    expect(body.incidents.map((i) => i.id).sort()).toEqual([...openIds].sort());
  });

  test('B2: ?state=closed returns only resolved|closed', async () => {
    const res = await __fixture.api.request(
      '/incidents?state=closed',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidents: Array<{ id: string; status: string }> };
    expect(body.incidents.every((i) => CLOSED_SCOPE.has(i.status))).toBe(true);
    expect(body.incidents.map((i) => i.id).sort()).toEqual([...closedIds].sort());
  });

  test('?state=all excludes soft-deleted incidents', async () => {
    const res = await __fixture.api.request(
      '/incidents?state=all',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      incidents: Array<{ id: string; archivedAt: string | null }>;
    };
    expect(body.incidents.map(({ id }) => id).sort()).toEqual([...openIds, ...closedIds].sort());
    expect(body.incidents.some(({ id }) => id === archivedId)).toBe(false);
  });

  test('searches incident identity and applies severity without changing scope counts', async () => {
    const token = await __fixture.sign(orgD);
    const searches = [
      'svc-open',
      'latency search marker',
      'prometheus-special',
      'C-search-scope',
      'incident-search-channel',
      automatedId.slice(0, 8),
    ];
    for (const query of searches) {
      const searched = await __fixture.api.request(
        `/incidents?state=all&query=${encodeURIComponent(query)}`,
        __fixture.auth(token),
      );
      expect(searched.status).toBe(200);
      const searchedBody = (await searched.json()) as {
        incidents: Array<{ id: string }>;
        counts: { all: number };
      };
      expect(searchedBody.incidents.map(({ id }) => id)).toContain(automatedId);
      expect(searchedBody.counts.all).toBe(4);
    }

    const literalWildcards = await __fixture.api.request(
      `/incidents?state=all&query=${encodeURIComponent('%_\\')}`,
      __fixture.auth(token),
    );
    expect(literalWildcards.status).toBe(200);
    expect(((await literalWildcards.json()) as { incidents: unknown[] }).incidents).toEqual([]);

    const severity = await __fixture.api.request(
      '/incidents?state=open&severity=sev3',
      __fixture.auth(token),
    );
    expect(severity.status).toBe(200);
    const severityBody = (await severity.json()) as { incidents: Array<{ id: string }> };
    expect(severityBody.incidents.map(({ id }) => id)).toEqual([automatedId]);
  });

  test('rejects invalid search filters', async () => {
    const token = await __fixture.sign(orgD);
    expect(
      (await __fixture.api.request('/incidents?state=all&severity=sev9', __fixture.auth(token)))
        .status,
    ).toBe(400);
    expect(
      (await __fixture.api.request('/incidents?state=all&query=a', __fixture.auth(token))).status,
    ).toBe(400);
    expect(
      (
        await __fixture.api.request(
          `/incidents?state=all&query=${'x'.repeat(201)}`,
          __fixture.auth(token),
        )
      ).status,
    ).toBe(400);
  });

  test('active attention filters return complete, disjoint handling lanes', async () => {
    const human = await __fixture.api.request(
      '/incidents?state=open&attention=human',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    const automation = await __fixture.api.request(
      '/incidents?state=open&attention=automation',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    const humanIds = ((await human.json()) as { incidents: Array<{ id: string }> }).incidents.map(
      ({ id }) => id,
    );
    const automationIds = (
      (await automation.json()) as { incidents: Array<{ id: string }> }
    ).incidents.map(({ id }) => id);

    expect(humanIds.sort()).toEqual(openIds.filter((id) => id !== automatedId).sort());
    expect(automationIds).toEqual([automatedId]);
  });

  test('rejects attention filters outside the active queue contract', async () => {
    const invalidValue = await __fixture.api.request(
      '/incidents?state=open&attention=unknown',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    const closedAttention = await __fixture.api.request(
      '/incidents?state=closed&attention=human',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(invalidValue.status).toBe(400);
    expect(closedAttention.status).toBe(400);
  });

  test('B4: the response carries true lifecycle and human-attention counts', async () => {
    const res = await __fixture.api.request(
      '/incidents?state=open',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    const body = (await res.json()) as {
      counts?: {
        all: number;
        open: number;
        needsHuman: number;
        automation: number;
        closed: number;
      };
    };
    expect(body.counts).toEqual({
      all: 4,
      open: 2,
      needsHuman: 1,
      automation: 1,
      closed: 2,
    });
  });

  test('a malformed cursor is a 400, not a silent page one', async () => {
    const bad = await __fixture.api.request(
      '/incidents?state=closed&cursor=not-base64!!',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(bad.status).toBe(400);

    // A well-formed base64url cursor whose id is not a UUID must ALSO 400 — decodeCursor rejects it so it
    // never reaches the uuid column (which would 22P02 → 500), honouring the malformed-cursor→400 contract.
    const nonUuid = Buffer.from(
      JSON.stringify({ createdAt: new Date().toISOString(), id: 'not-a-uuid' }),
    ).toString('base64url');
    const res = await __fixture.api.request(
      `/incidents?state=closed&cursor=${encodeURIComponent(nonUuid)}`,
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(400);
  });

  test('the active priority queue rejects even a valid closed-archive cursor', async () => {
    const closed = await __fixture.api.request(
      '/incidents?state=closed&limit=1',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    const { nextCursor } = (await closed.json()) as { nextCursor: string | null };
    expect(nextCursor).not.toBeNull();

    const res = await __fixture.api.request(
      `/incidents?state=open&cursor=${encodeURIComponent(nextCursor!)}`,
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'cursor is only valid for closed or all incidents' });
  });

  test('parseLimit: ?limit=1 returns one row with a further cursor; ?limit=999 is clamped, not an error', async () => {
    const res1 = await __fixture.api.request(
      '/incidents?state=closed&limit=1',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res1.status).toBe(200);
    const b1 = (await res1.json()) as { incidents: unknown[]; nextCursor: string | null };
    expect(b1.incidents).toHaveLength(1); // the bound is honoured (tenantD has 2 closed)
    expect(b1.nextCursor).not.toBeNull(); // more remain, so a cursor is offered

    const res2 = await __fixture.api.request(
      '/incidents?state=closed&limit=999',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res2.status).toBe(200); // clamp does not error
    const b2 = (await res2.json()) as { incidents: unknown[] };
    expect(b2.incidents).toHaveLength(2); // all of tenantD's closed incidents
  });

  test('B3 (round-trip): the closed archive pages via nextCursor with no overlap; nextCursor ends null', async () => {
    // A dedicated tenant with >2 closed incidents, so paging at limit=1 takes multiple hops. Isolated so
    // tenantD's B4 counts are untouched; cleaned up in the finally.
    const orgE = `org_${randomUUID().slice(0, 8)}`;
    const tenantE = randomUUID();
    await __fixture.admin.db.insert(tenants).values([{ id: tenantE, name: 'E' }]);
    await seedMembership(__fixture.admin.db, { issuer: __fixture.ISSUER, subject: orgE }, tenantE);
    await bindTestIdentity({
      adminDb: __fixture.admin.db,
      issuer: __fixture.ISSUER,
      tenantId: tenantE,
      subject: orgE,
    });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { id } = await createIncident(__fixture.app.db, tenantE, {
          fingerprint: `e-${randomUUID()}`,
          alertSource: 'datadog',
          service: `svc-${i}`,
          severity: 'sev2',
        });
        await __fixture.admin.db
          .update(incidents)
          .set({ status: 'closed' })
          .where(sql`id = ${id}`);
        ids.push(id);
      }

      const seen = new Set<string>();
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const q = cursor
          ? `/incidents?state=closed&limit=1&cursor=${encodeURIComponent(cursor)}`
          : '/incidents?state=closed&limit=1';
        const res = await __fixture.api.request(q, __fixture.auth(await __fixture.sign(orgE)));
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          incidents: Array<{ id: string }>;
          nextCursor: string | null;
        };
        expect(body.incidents).toHaveLength(1);
        for (const inc of body.incidents) {
          expect(seen.has(inc.id)).toBe(false); // no overlap across pages
          seen.add(inc.id);
        }
        cursor = body.nextCursor;
        pages++;
        expect(pages).toBeLessThanOrEqual(5); // a terminating cursor, never a loop
      } while (cursor);

      expect(seen.size).toBe(3); // every closed incident surfaced exactly once
      expect([...seen].sort()).toEqual([...ids].sort());
    } finally {
      await __fixture.admin.db.delete(incidents).where(sql`tenant_id = ${tenantE}`);
      await __fixture.admin.db.delete(memberships).where(sql`tenant_id = ${tenantE}`);
      await __fixture.admin.db.delete(tenantIdentityBindings).where(sql`tenant_id = ${tenantE}`);
      await __fixture.admin.db
        .delete(users)
        .where(sql`issuer = ${__fixture.ISSUER} and subject = ${orgE}`);
      await __fixture.admin.db.delete(tenants).where(sql`id = ${tenantE}`);
    }
  });
});

// a human commands runbook generation. The route enqueues a durable job and returns
// 202 immediately — no LLM on the request path (Postgres-row-before-stream). RED now: the
// route does not exist, so every POST currently 404s.
describe('POST /incidents/:id/generate-runbook', () => {
  async function post(id: string, token: string): Promise<Response> {
    return __fixture.api.request(`/incidents/${id}/generate-runbook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  test('C1: enqueues a runbook.generate job and returns 202 without invoking the LLM', async () => {
    const res = await post(__fixture.runbookIncidentId, await __fixture.sign(__fixture.orgC));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBeTruthy();

    const rows = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`id = ${body.jobId}`);
    expect(rows[0]).toMatchObject({
      tenantId: __fixture.tenantC,
      type: 'runbook.generate',
      stream: 'sre:runbook',
      status: 'queued',
    });
    expect((rows[0]!.payload as { incidentId: string }).incidentId).toBe(
      __fixture.runbookIncidentId,
    );
  });

  test('a double-click is idempotent: the second POST returns 202 with the existing jobId, not a 500', async () => {
    const first = await post(__fixture.runbookIncidentId, await __fixture.sign(__fixture.orgC));
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };

    // The second POST used to hit the pending job's coalescing index and raise 23505 straight out of
    // Queue.enqueue → 500.
    const second = await post(__fixture.runbookIncidentId, await __fixture.sign(__fixture.orgC));
    expect(second.status).toBe(202);
    expect(((await second.json()) as { jobId: string }).jobId).toBe(jobId);

    // One pending generation for the incident, so the distiller cannot run twice and double-write.
    const pending = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(
        sql`type = 'runbook.generate' and payload->>'incidentId' = ${__fixture.runbookIncidentId} and status in ('queued','processing')`,
      );
    expect(pending).toHaveLength(1);
  });

  test('a non-UUID id returns 404 (guarded before the DB, not a 500)', async () => {
    expect((await post('not-a-uuid', await __fixture.sign(__fixture.orgC))).status).toBe(404);
  });

  test('a missing incident returns 404', async () => {
    expect((await post(randomUUID(), await __fixture.sign(__fixture.orgC))).status).toBe(404);
  });

  test('a deletion race rejected by the queue maps to 404 without a durable job', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `runbook-delete-race-${randomUUID()}`,
        alertSource: 'slack',
        service: 'runbook-delete-race',
        severity: 'sev3',
      })
    ).id;
    const enqueue = vi
      .spyOn(__fixture.runbookQueue, 'enqueue')
      .mockRejectedValueOnce(new IncidentUnavailableError(id));

    const response = await post(id, await __fixture.sign(__fixture.orgC));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'incident not found' });
    expect(
      await __fixture.admin.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(sql`type = 'runbook.generate' and payload->>'incidentId' = ${id}`),
    ).toEqual([]);
    enqueue.mockRestore();
  });

  test('another tenant cannot generate a runbook for this incident (404 under RLS)', async () => {
    // orgA is a member of tenantA but does not own tenantC's incident → RLS 404.
    expect(
      (await post(__fixture.runbookIncidentId, await __fixture.sign(__fixture.orgA))).status,
    ).toBe(404);
  });
});
