import { seedMembership } from '@sre/db/test-support';
import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { WS_CLOSE_POLICY } from '@sre/contracts';
import { incidents } from '@sre/db';

import {
  IngestRefusedError,
  MAX_CONTENT_CHARS,
  openIncidentSession,
  type SessionDeps,
} from '../session';

import { createFixture } from './session.fixture';

const __fixture = createFixture();

describe('dashboard surface session', () => {
  test('replays history, projects live messages, and ingests input back into the hub', async () => {
    await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'agent',
      content: 'investigating',
    });

    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: __fixture.incidentId,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();
    await __fixture.waitFor(() => c.messages().some((m) => m.content === 'investigating'));

    // Live fan-out: a new hub append reaches the open session.
    await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'agent',
      content: 'found the cause',
    });
    await __fixture.waitFor(() => c.messages().some((m) => m.content === 'found the cause'));

    // Ingest: human input from the surface lands in the canonical hub.
    await session!.adapter.ingest({ content: 'ack, on it' });
    await __fixture.waitFor(() =>
      c.messages().some((m) => m.author === 'human' && m.content === 'ack, on it'),
    );
    const history = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(history.some((m) => m.author === 'human' && m.content === 'ack, on it')).toBe(true);

    // The human reply enqueues a coalescing resume carrying the session tenant + the appended
    // message id, so the worker can rebuild the prior transcript and run engine.resume.
    const resume = __fixture.enqueued.find((j) => j.incidentId === __fixture.incidentId);
    expect(resume).toBeDefined();
    expect(resume!.tenantId).toBe(__fixture.tenantA);
    expect(resume!.humanMessageId).toBeTruthy();

    await session!.close();
  });

  test('retries a dashboard client message id without duplicating the hub row or resume', async () => {
    const id = await __fixture.freshIncident();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: __fixture.collector().sink,
    });
    const clientMessageId = randomUUID();
    const content = `idempotent-${randomUUID()}`;

    const first = await session!.adapter.ingest({ content, clientMessageId });
    const second = await session!.adapter.ingest({ content, clientMessageId });

    expect(second.id).toBe(first.id);
    const history = await __fixture.hub.history(__fixture.tenantA, id);
    expect(history.filter((message) => message.id === first.id)).toHaveLength(1);
    expect(__fixture.enqueued.filter((job) => job.humanMessageId === first.id)).toHaveLength(1);
    await session!.close();
  });

  test('rejects another tenant (a ticket for B cannot open A’s incident) — even when B carries a userId', async () => {
    const c = __fixture.collector();
    // The ticket carries a (tenant-B) userId; rejection must still win over attribution — the
    // tenant-scoped getIncident check short-circuits before ingest, so no author_user_id is ever
    // stamped into tenant A's incident. The uuid need not be a real member: the append never runs.
    const { ticket } = await __fixture.mintTicket({
      tenantId: __fixture.tenantB,
      sub: 'u',
      userId: __fixture.userB,
    });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: __fixture.incidentId,
      ticket,
      sink: c.sink,
    });
    expect(session).toBeNull();
    // The tenant-scoped lookup misses, so the reason must be the not-visible one. Asserting the pair
    // keeps this from passing on any other 1008 close (an expired token, an unredeemable ticket).
    expect(c.closed()).toEqual([WS_CLOSE_POLICY, 'forbidden']);
    expect(c.messages()).toHaveLength(0);
  });

  test('rejects an invalid or missing ticket', async () => {
    const bad = __fixture.collector();
    expect(
      await openIncidentSession(__fixture.deps, {
        incidentId: __fixture.incidentId,
        ticket: 'garbage',
        sink: bad.sink,
      }),
    ).toBeNull();
    // Redemption failed, so the reason must be the ticket one and not, say, an expiry close.
    expect(bad.closed()).toEqual([WS_CLOSE_POLICY, 'invalid ticket']);

    const missing = __fixture.collector();
    expect(
      await openIncidentSession(__fixture.deps, {
        incidentId: __fixture.incidentId,
        ticket: undefined,
        sink: missing.sink,
      }),
    ).toBeNull();
    expect(missing.closed()).toEqual([WS_CLOSE_POLICY, 'invalid ticket']);
  });

  test('a human reply and its resume job are atomic: a failed resume enqueue rolls back the message', async () => {
    // Fake-throw seam: the resume producer throws to simulate a crash/failure at the resume step.
    // Phase B renames the resume call to an in-tx insert (e.g. insertResumeTx) that shares the
    // message's transaction; when it does, wire the fake's THROW onto whatever method ingest calls
    // in-tx so this test stays valid. The invariant under test is: if the resume step throws, the
    // human message must NOT be persisted.
    const throwingDeps: SessionDeps = {
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      tickets: __fixture.tickets,
      sessionRegistry: __fixture.deps.sessionRegistry,
      queue: {
        // The throw fires INSIDE the shared tx (insertResumeTx runs on the message's tx), so it rolls
        // the human message back with it — the invariant.
        insertResumeTx: async () => {
          throw new Error('resume enqueue failed (simulated crash at resume step)');
        },
        publishResume: async () => {},
      },
    };

    // A NON-human message never touches the resume path, so it ingests fine (sanity companion).
    const agentContent = `agent-note-${randomUUID()}`;
    {
      const c = __fixture.collector();
      const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
      const session = await openIncidentSession(throwingDeps, {
        incidentId: __fixture.incidentId,
        ticket,
        sink: c.sink,
      });
      expect(session).not.toBeNull();
      await expect(
        session!.adapter.ingest({ content: agentContent, author: 'agent' }),
      ).resolves.toBeDefined();
      await session!.close();
    }

    // A human reply drives the resume path, so the throwing enqueue must reject the ingest.
    const humanContent = `human-reply-${randomUUID()}`;
    {
      const c = __fixture.collector();
      const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
      const session = await openIncidentSession(throwingDeps, {
        incidentId: __fixture.incidentId,
        ticket,
        sink: c.sink,
      });
      expect(session).not.toBeNull();
      await expect(session!.adapter.ingest({ content: humanContent })).rejects.toThrow();
      await session!.close();
    }

    // Atomicity assertion: the message and the resume insert share one tx, so a resume enqueue that
    // throws rolls the message back. Were hub.append to commit in its own tx first, the message would
    // persist despite the throw and leave an orphaned reply.
    const history = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(history.some((m) => m.content === humanContent)).toBe(false);
    // Sanity: the agent message (which never touched the resume path) did persist.
    expect(history.some((m) => m.author === 'agent' && m.content === agentContent)).toBe(true);
  });

  test('a ticket is single-use', async () => {
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const first = await openIncidentSession(__fixture.deps, {
      incidentId: __fixture.incidentId,
      ticket,
      sink: __fixture.collector().sink,
    });
    expect(first).not.toBeNull();
    await first!.close();

    const c = __fixture.collector();
    const second = await openIncidentSession(__fixture.deps, {
      incidentId: __fixture.incidentId,
      ticket,
      sink: c.sink,
    });
    expect(second).toBeNull();
    // A spent ticket redeems to nothing, so the second open must fail as an invalid ticket. The pair
    // form keeps a same-code close for a different reason from passing for single use.
    expect(c.closed()).toEqual([WS_CLOSE_POLICY, 'invalid ticket']);
  });

  // An authed platform user posting via the dashboard is attributed. The user id
  // rides the ticket (mint→redeem→append round-trip), the appended human message is stamped with
  // that platform users.id and origin_surface='dashboard', and the reply still enqueues its
  // resume: attribution is orthogonal to the resume trigger.
  test('stamps author_user_id + origin_surface=dashboard on an attributed human post', async () => {
    // A real member is required: author_user_id FK-references users.id, so a random uuid would RI-fail
    // once production stamps it. Seed the member and carry its id, not a synthetic one.
    const userId = await seedMembership(
      __fixture.admin.db,
      { issuer: __fixture.SEED_ISSUER, subject: `c1-${randomUUID()}`, email: 'c1@example.com' },
      __fixture.tenantA,
    );

    const c = __fixture.collector();
    // RED: TicketContext does not carry `userId` today, so production never plumbs it to the append.
    const { ticket } = await __fixture.mintTicket({
      tenantId: __fixture.tenantA,
      sub: 'u',
      userId,
    });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: __fixture.incidentId,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    const content = `attributed-${randomUUID()}`;
    const appended = await session!.adapter.ingest({ content });

    // Appended message is attributed to the seeded platform user id.
    expect(appended.authorUserId).toBe(userId);
    // A dashboard post carries origin_surface='dashboard'.
    expect(appended.originSurface).toBe('dashboard');

    // Same attribution is durable in the canonical hub, not just the returned value.
    const history = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    const stored = history.find((m) => m.content === content);
    expect(stored?.authorUserId).toBe(userId);
    expect(stored?.originSurface).toBe('dashboard');

    // An attributed human reply still enqueues its coalescing resume.
    const resume = __fixture.enqueued.find((j) => j.humanMessageId === appended.id);
    expect(resume).toBeDefined();
    expect(resume!.tenantId).toBe(__fixture.tenantA);

    await session!.close();
  });

  // the ingest path has a per-socket rate limit but no content bound and no terminal-status gate.
  // Both gates belong in adapter.ingest (before the shared tx), so every caller is covered — not in ws.ts.
  // The cap REJECTS rather than truncates: SLACK_TEXT_MAX is an egress render cap, and silently rewriting
  // a human's message on the write path is not something this codebase does anywhere.
  test('rejects an over-length post: nothing appended, nothing enqueued', async () => {
    const id = await __fixture.freshIncident();
    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    // Pinned to the exported constant, ON the boundary: a length picked far above the cap would pass for
    // any cap, so an off-by-one (> vs >=) or a later bump would go uncaught.
    const over = 'x'.repeat(MAX_CONTENT_CHARS + 1);
    await expect(session!.adapter.ingest({ content: over })).rejects.toThrow(IngestRefusedError);
    // The wire `code` is the contract the dashboard keys on, so assert it, not just "something threw":
    // a bare toThrow() is equally satisfied by an RLS denial or a typo-induced TypeError.
    await expect(session!.adapter.ingest({ content: over })).rejects.toMatchObject({
      code: 'content_too_long',
    });

    const history = await __fixture.hub.history(__fixture.tenantA, id);
    expect(history.some((m) => m.content === over)).toBe(false);
    expect(__fixture.enqueued.filter((j) => j.incidentId === id)).toHaveLength(0);

    await session!.close();
  });

  test('a post of exactly MAX_CONTENT_CHARS is ACCEPTED (the bound is inclusive)', async () => {
    const id = await __fixture.freshIncident();
    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });

    const atCap = 'y'.repeat(MAX_CONTENT_CHARS);
    const appended = await session!.adapter.ingest({ content: atCap });
    expect(appended.content).toBe(atCap);

    await session!.close();
  });

  test('resolved incidents remain open for diagnosis and follow-up discussion', async () => {
    const id = await __fixture.freshIncident();
    await __fixture.setLifecycle(__fixture.tenantA, id, 'resolved');

    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    const content = `post-to-resolved-${randomUUID()}`;
    const appended = await session!.adapter.ingest({ content });
    expect(appended.content).toBe(content);

    const history = await __fixture.hub.history(__fixture.tenantA, id);
    expect(history.some((m) => m.content === content)).toBe(true);
    expect(__fixture.enqueued.filter((j) => j.incidentId === id)).toHaveLength(1);

    await session!.close();
  });

  test('an already-open session refuses new messages after the incident is archived', async () => {
    const id = await __fixture.freshIncident();
    await __fixture.setLifecycle(__fixture.tenantA, id, 'resolved');
    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    const archived = await __fixture.hub.setIncidentArchived(__fixture.tenantA, id, {
      archived: true,
      reason: 'Archive session test.',
      archiveKey: `archive-session:${randomUUID()}`,
      author: 'system',
      expectedVersion: 1,
    });
    expect(archived.archive.outcome).toBe('applied');
    await vi.waitFor(() => expect(c.closed()).toEqual([1008, 'forbidden']));
    expect(c.messages().some((message) => message.kind === 'archive')).toBe(false);

    await expect(session!.adapter.ingest({ content: 'late reply' })).rejects.toMatchObject({
      code: 'incident_archived',
      message: 'this incident was deleted and cannot accept new messages',
    });
    expect(
      (await __fixture.hub.history(__fixture.tenantA, id)).some(
        (message) => message.content === 'late reply',
      ),
    ).toBe(false);
    expect(__fixture.enqueued.filter((job) => job.incidentId === id)).toHaveLength(0);

    await session!.close();
  });

  test('an archived incident cannot open a new dashboard session or replay history', async () => {
    const id = await __fixture.freshIncident();
    await __fixture.setLifecycle(__fixture.tenantA, id, 'resolved');
    await __fixture.hub.append(__fixture.tenantA, id, {
      author: 'system',
      content: 'private deleted history',
    });
    const archived = await __fixture.hub.setIncidentArchived(__fixture.tenantA, id, {
      archived: true,
      reason: 'Delete session test.',
      archiveKey: `delete-session:${randomUUID()}`,
      author: 'system',
      expectedVersion: 1,
    });
    expect(archived.archive.outcome).toBe('applied');

    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });

    expect(session).toBeNull();
    expect(c.closed()).toEqual([1008, 'forbidden']);
    expect(c.messages()).toEqual([]);
  });

  test('a live session revalidates durable visibility when archive publication is missed', async () => {
    const id = await __fixture.freshIncident();
    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    // Simulate the commit-to-publish crash window: the tombstone commits but its archive event never
    // reaches Redis. A later publication must still be rejected from durable state.
    await __fixture.admin.db
      .update(incidents)
      .set({ archivedAt: new Date() })
      .where(sql`${incidents.id} = ${id}`);
    await __fixture.hub.publishPersisted({
      id: randomUUID(),
      incidentId: id,
      author: 'system',
      kind: 'status',
      content: 'must not project after deletion',
      createdAt: new Date(),
    });

    await vi.waitFor(() => expect(c.closed()).toEqual([1008, 'forbidden']));
    expect(
      c.messages().some((message) => message.content === 'must not project after deletion'),
    ).toBe(false);
    await session!.close();
  });

  test('deletion committed during history loading rejects the entire replay', async () => {
    const id = await __fixture.freshIncident();
    await __fixture.hub.append(__fixture.tenantA, id, {
      author: 'system',
      content: 'must remain deleted history',
    });
    const originalHistory = __fixture.hub.history.bind(__fixture.hub);
    let releaseHistory!: () => void;
    const historyReleased = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let historyStarted!: () => void;
    const historyReached = new Promise<void>((resolve) => {
      historyStarted = resolve;
    });
    const historySpy = vi
      .spyOn(__fixture.hub, 'history')
      .mockImplementationOnce(async (...args) => {
        historyStarted();
        await historyReleased;
        return originalHistory(...args);
      });
    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });

    const opening = openIncidentSession(__fixture.deps, { incidentId: id, ticket, sink: c.sink });
    await historyReached;
    await __fixture.admin.db
      .update(incidents)
      .set({ archivedAt: new Date() })
      .where(sql`${incidents.id} = ${id}`);
    releaseHistory();

    expect(await opening).toBeNull();
    expect(c.closed()).toEqual([1008, 'forbidden']);
    expect(c.messages()).toEqual([]);
    historySpy.mockRestore();
  });
});
