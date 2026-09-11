import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { jobs } from '@sre/db';

import { openIncidentSession, type SessionDeps } from '../session';

import { createFixture } from './session.fixture';

const __fixture = createFixture();

describe('dashboard surface session', () => {
  test('archive waits for an in-flight reply transaction and then refuses while its resume is queued', async () => {
    const id = await __fixture.freshIncident();
    await __fixture.setLifecycle(__fixture.tenantA, id, 'resolved');
    let releaseInsert!: () => void;
    const insertReleased = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let reachedInsert!: () => void;
    const insertReached = new Promise<void>((resolve) => {
      reachedInsert = resolve;
    });
    const racingDeps: SessionDeps = {
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      tickets: __fixture.tickets,
      sessionRegistry: __fixture.deps.sessionRegistry,
      queue: {
        insertResumeTx: async (tx, queuedTenantId, queuedIncidentId, humanMessageId) => {
          const inserted = await tx
            .insert(jobs)
            .values({
              tenantId: queuedTenantId,
              type: 'resume',
              payload: { incidentId: queuedIncidentId, humanMessageId },
              status: 'queued',
              stream: `archive-race-${randomUUID()}`,
            })
            .returning({ id: jobs.id });
          reachedInsert();
          await insertReleased;
          return { jobId: inserted[0]!.id };
        },
        publishResume: async () => {},
      },
    };
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(racingDeps, {
      incidentId: id,
      ticket,
      sink: __fixture.collector().sink,
    });

    const ingest = session!.adapter.ingest({ content: 'reply racing with archive' });
    await insertReached;
    let archiveSettled = false;
    const archive = __fixture.hub
      .setIncidentArchived(__fixture.tenantA, id, {
        archived: true,
        reason: 'Archive race test.',
        archiveKey: `archive-race:${randomUUID()}`,
        author: 'system',
        expectedVersion: 1,
      })
      .then((result) => {
        archiveSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(archiveSettled).toBe(false);

    releaseInsert();
    await ingest;
    expect((await archive).archive.outcome).toBe('work_in_progress');
    expect(
      (await __fixture.hub.history(__fixture.tenantA, id)).some((message) =>
        message.content.includes('archived:'),
      ),
    ).toBe(false);

    await session!.close();
  });

  test('closed incidents also remain available for discussion without an implicit reopen', async () => {
    const id = await __fixture.freshIncident();
    await __fixture.setLifecycle(__fixture.tenantA, id, 'closed');

    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    const content = `reopen-closed-${randomUUID()}`;
    const appended = await session!.adapter.ingest({ content });
    expect(appended.content).toBe(content);

    const history = await __fixture.hub.history(__fixture.tenantA, id);
    expect(history.some((m) => m.content === content)).toBe(true);

    await session!.close();
  });

  test('a session opened before resolution remains writable after the lifecycle changes', async () => {
    const id = await __fixture.freshIncident();

    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    // Session opens while the incident is still 'open' — the snapshot it holds is postable.
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    // ...then the incident resolves out from under the already-open socket.
    await __fixture.setLifecycle(__fixture.tenantA, id, 'resolved');

    const content = `stale-session-${randomUUID()}`;
    const appended = await session!.adapter.ingest({ content });
    expect(appended.content).toBe(content);

    const history = await __fixture.hub.history(__fixture.tenantA, id);
    expect(history.some((m) => m.content === content)).toBe(true);
    expect(__fixture.enqueued.filter((j) => j.incidentId === id)).toHaveLength(1);

    await session!.close();
  });

  // regression lock: the gates must not change the happy path.
  test('a within-cap post to a postable incident still appends and enqueues its resume', async () => {
    const id = await __fixture.freshIncident();
    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    const content = `within-cap-${randomUUID()}`;
    const appended = await session!.adapter.ingest({ content });
    expect(appended.content).toBe(content);

    const history = await __fixture.hub.history(__fixture.tenantA, id);
    expect(history.some((m) => m.author === 'human' && m.content === content)).toBe(true);
    expect(__fixture.enqueued.some((j) => j.humanMessageId === appended.id)).toBe(true);

    await session!.close();
  });

  // symmetry: Slack scrubs human text at both its ingest points, so the dashboard WS ingest must too.
  // Otherwise a credential pasted into the chat box is persisted verbatim in incident_messages and
  // re-egressed to the LLM on the resume this very post enqueues.
  test('a pasted credential is scrubbed at the dashboard ingest boundary', async () => {
    const id = await __fixture.freshIncident();
    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
    const session = await openIncidentSession(__fixture.deps, {
      incidentId: id,
      ticket,
      sink: c.sink,
    });

    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const appended = await session!.adapter.ingest({ content: `try this key ${secret}` });
    expect(appended.content).toContain('[REDACTED]');
    expect(appended.content).not.toContain(secret);

    // Durable in the canonical hub, not just the returned value: the hub row is what resume re-reads.
    const history = await __fixture.hub.history(__fixture.tenantA, id);
    const stored = history.find((m) => m.id === appended.id);
    expect(stored?.content).toContain('[REDACTED]');
    expect(history.some((m) => m.content.includes(secret))).toBe(false);

    await session!.close();
  });
});
