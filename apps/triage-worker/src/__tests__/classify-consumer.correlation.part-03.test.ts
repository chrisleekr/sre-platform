import { ThreadAlreadyBoundError } from '@sre/alerts';

import { bumpIncidentOccurrenceOnce } from '@sre/db';

import { describe, expect, test, vi } from 'vitest';

// hermetic behavior tests for in-context correlation in the classify consumer.
// The consumer builds a candidate open-incident set (listActiveIncidents; retrieveNearestActive over
// CAP_N), runs the correlation classifier, and resolves the verdict:
//   not_worthy   -> ack
//   belongs_to   -> append + coalesced resume; bot alerts also bump recurrence
//                   to the hub + enqueues a resume
//   new_incident -> route a NEW structural-fingerprint incident, persist title, best-effort embed seed
// The repo shortlist fns are mocked so these stay hermetic (no live PG). RED now: the consumer still
// runs the {worthy} classifier and never builds candidates / resolves a correlation verdict.
vi.mock('@sre/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    lookupSurfaceIdentity: vi.fn(async () => 'user-human'),
    listActiveIncidents: vi.fn(),
    retrieveNearestActive: vi.fn(),
    setIncidentEmbedding: vi.fn(async () => undefined),
    bumpIncidentOccurrenceOnce: vi.fn(async () => true),
    getBindingByIncident: vi.fn(),
    recordSurfaceBinding: vi.fn(async (_tx, _tenantId, input) => ({
      id: 'source-binding',
      incidentId: input.incidentId,
      channel: input.channel,
      threadId: input.threadId,
      externalId: `${input.channel}:${input.threadId}`,
      role: input.role ?? 'primary',
    })),
    activateSurfaceBinding: vi.fn(async (_tx, _tenantId, _surface, _incidentId, bindingId) => ({
      id: bindingId,
    })),
    withTenant: vi.fn(async (exec, _tenantId, fn) => fn(exec)),
  };
});

import { createFixture } from './classify-consumer.correlation.fixture';

const __fixture = createFixture();

// --- inbound side-effect idempotency, DURABLE (Postgres, not Valkey) -----------------------
// The classify job is at-least-once: a crash after the side effect but before the ACK
// redelivers the identical payload. routeToIncident is idempotent (fingerprint dedup), but the belongs_to
// side effects were not — a redelivery double-counted occurrence_count and double-posted the human's line
// (waking the engine twice for one sentence).
//
// The old Valkey SET-NX guard could not close this: it released the key on a THROW, and a SIGKILL is not a
// throw, so a worker killed between the reservation and the Postgres write left the redelivery skipping
// the side effect and ACKing — the human's reply lost forever. Postgres is the durable record instead:
//   - human attach -> hub.appendOnce, unique on (tenant_id, origin_message_id) = `slack:<channel>:<ts>`
//   - bot alert    -> hub.appendOnce plus bumpIncidentOccurrenceOnce; both are idempotent
// Both are idempotent BY CONSTRUCTION, so the consumer simply re-runs. The doubles below stand in for
// those two unique constraints; the live-Postgres proofs are in classify-consumer.correlation-rls.test.ts.
describe('belongs_to redelivery idempotency (durable)', () => {
  const key = (channel: string, messageId: string): string => `slack:${channel}:${messageId}`;

  test('C15/C19 a redelivered BOT belongs_to job bumps occurrence_count exactly once', async () => {
    __fixture.ledgerBackedBump();
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const { handler, appendOnce } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active,
    });
    const job = __fixture.makeJob({
      payload: __fixture.makeCandidate({ author: 'bot', externalId: '1699999999.4242' }),
    });

    await handler(job);
    await handler(job); // the SAME job, redelivered (identical payload, stable externalId)

    // The consumer re-runs on every delivery — the LEDGER decides, in the same transaction as the bump.
    const wins = vi.mocked(bumpIncidentOccurrenceOnce).mock.results.map((r) => r.value);
    expect(await Promise.all(wins)).toEqual([true, false]); // bumped once, then a no-op
    // Keyed per (tenant, channel, surface message id) — the push message id is candidate.externalId.
    expect(vi.mocked(bumpIncidentOccurrenceOnce)).toHaveBeenCalledWith(
      __fixture.stubDb,
      'tenant-1',
      'inc-A',
      key('C123', '1699999999.4242'),
    );
    const appends = await Promise.all(appendOnce.mock.results.map((result) => result.value));
    expect(appends.map((result) => result.inserted)).toEqual([true]);
  });

  test('a BOT redelivery with a drifted verdict bumps the incident that owns the durable alert', async () => {
    const active = [
      __fixture.summary({ id: 'inc-A', title: 'A' }),
      __fixture.summary({ id: 'inc-B', title: 'B' }),
    ];
    let delivery = 0;
    const { handler, appendOnce, enqueueResume } = __fixture.setup({
      verdict: () => ({ decision: 'belongs_to', index: ++delivery === 1 ? 1 : 2 }),
      active,
    });
    const job = __fixture.makeJob({
      payload: __fixture.makeCandidate({ author: 'bot', externalId: '1699999999.4343' }),
    });
    vi.mocked(bumpIncidentOccurrenceOnce)
      .mockRejectedValueOnce(new Error('worker died before the occurrence transaction'))
      .mockResolvedValueOnce(true);

    await expect(handler(job)).rejects.toThrow();
    await handler(job);

    const appends = await Promise.all(appendOnce.mock.results.map((result) => result.value));
    expect(appends.map((result) => result.message.incidentId)).toEqual(['inc-A']);
    expect(vi.mocked(bumpIncidentOccurrenceOnce).mock.calls.map((call) => call[2])).toEqual([
      'inc-A',
      'inc-A',
    ]);
    expect(enqueueResume).not.toHaveBeenCalled();
  });

  test('C16 a redelivered HUMAN belongs_to job appends ONE hub line, keyed on the surface message', async () => {
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const { handler, appendOnce, enqueueResume } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active,
    });
    const job = __fixture.makeJob({
      payload: __fixture.makeCandidate({ author: 'human', externalId: '1699999999.11' }),
    });

    await handler(job);
    await handler(job);

    // Both deliveries call the hub; the (tenant, origin_message_id) unique collapses the second onto the
    // same row, so exactly ONE line exists and the engine is woken for one message.
    const results = await Promise.all(appendOnce.mock.results.map((r) => r.value));
    expect(results.map((r) => r.inserted)).toEqual([true, false]);
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(appendOnce.mock.calls[0]![2]).toMatchObject({
      originMessageId: key('C123', '1699999999.11'),
    });
    // ...and the resume is enqueued for the SAME hub message id both times: enqueueResume is itself
    // idempotent (coalesce index + the watermark pre-gate), so re-running it is a no-op.
    expect(enqueueResume.mock.calls.map((c) => c[2])).toEqual(['hub-1', 'hub-1']);
  });

  // THE CRASH WINDOW — the reason this is Postgres-backed and not Valkey-backed. The first delivery
  // COMMITS the hub line and then dies (here: enqueueResume throws, standing in for the SIGKILL that a
  // release-on-throw guard can never see). The redelivery must self-heal: still ONE hub line, and the
  // resume must NOT be lost.
  test('C18 a crash AFTER the hub write: the redelivery adds no second line and still enqueues the resume', async () => {
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const { handler, appendOnce, enqueueResume } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active,
    });
    const job = __fixture.makeJob({
      payload: __fixture.makeCandidate({ author: 'human', externalId: '1699999999.9' }),
    });

    enqueueResume.mockRejectedValueOnce(new Error('worker died before the ACK'));
    await expect(handler(job)).rejects.toThrow(); // the job is NOT acked -> the queue redelivers

    await handler(job); // the redelivery

    const results = await Promise.all(appendOnce.mock.results.map((r) => r.value));
    expect(results.map((r) => r.inserted)).toEqual([true, false]); // exactly ONE hub line survives
    // The resume is enqueued even though the append was a no-op. Skipping it when `inserted === false`
    // would lose the human's reply forever — the very bug class this design removes.
    expect(enqueueResume).toHaveBeenCalledTimes(2);
    expect(enqueueResume.mock.calls[1]).toEqual(['tenant-1', 'inc-A', 'hub-1']);
  });

  test('C17 foldIntoOwner (thread already bound) is durable too: one bump across a redelivery', async () => {
    __fixture.ledgerBackedBump();
    // The third, easily-missed entry point: the funnel rejects with ThreadAlreadyBoundError and the
    // message folds into the owning incident — bumping (bot) or attaching (human) exactly as belongs_to.
    const { handler } = __fixture.setup({
      verdict: { decision: 'new_incident', service: 'checkout', severity: 'sev2', title: 't' },
      routeImpl: async () => {
        throw new ThreadAlreadyBoundError('inc-owner');
      },
    });
    const job = __fixture.makeJob({
      payload: __fixture.makeCandidate({ author: 'bot', externalId: '1699999999.7' }),
    });

    await handler(job);
    await handler(job);

    const wins = await Promise.all(
      vi.mocked(bumpIncidentOccurrenceOnce).mock.results.map((r) => r.value),
    );
    expect(wins).toEqual([true, false]);
    expect(vi.mocked(bumpIncidentOccurrenceOnce)).toHaveBeenCalledWith(
      __fixture.stubDb,
      'tenant-1',
      'inc-owner',
      key('C123', '1699999999.7'),
    );
  });

  test('C18 a bump that THROWS is retried by the redelivery (the ledger row rolls back with it)', async () => {
    __fixture.ledgerBackedBump();
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const { handler } = __fixture.setup({ verdict: { decision: 'belongs_to', index: 1 }, active });
    const job = __fixture.makeJob({
      payload: __fixture.makeCandidate({ author: 'bot', externalId: '1699999999.5' }),
    });

    // A Postgres blip: ledger row + bump are ONE transaction, so nothing is recorded and the redelivery
    // must be free to bump. (A Valkey reserve that failed to release would have suppressed it for 24h.)
    vi.mocked(bumpIncidentOccurrenceOnce).mockImplementationOnce(async () => {
      throw new Error('pg down');
    });
    await expect(handler(job)).rejects.toThrow();

    await handler(job); // the redelivery

    const settled = await Promise.allSettled(
      vi.mocked(bumpIncidentOccurrenceOnce).mock.results.map((r) => r.value),
    );
    expect(settled.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    // The retry LANDED the bump: nothing was recorded by the failed attempt, so it did not suppress it.
    expect(settled[1]).toMatchObject({ value: true });
  });

  test('C21 the key is tenant-scoped: the same message id in another tenant still lands', async () => {
    __fixture.ledgerBackedBump();
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const a = __fixture.setup({ verdict: { decision: 'belongs_to', index: 1 }, active });
    const b = __fixture.setup({ verdict: { decision: 'belongs_to', index: 1 }, active });
    const payload = __fixture.makeCandidate({ author: 'bot', externalId: 'SHARED.1' });

    await a.handler(__fixture.makeJob({ payload, tenantId: 'tenant-1' }));
    await b.handler(__fixture.makeJob({ payload, tenantId: 'tenant-2' }));

    // Same messageKey, different tenants: both bump (the unique is on (tenant_id, message_key)).
    const wins = await Promise.all(
      vi.mocked(bumpIncidentOccurrenceOnce).mock.results.map((r) => r.value),
    );
    expect(wins).toEqual([true, true]);
  });

  test('C16/C19 a redelivered MENTION belongs_to appends once, keyed on candidate.ts', async () => {
    const { handler, appendOnce, enqueueResume } = __fixture.setupMention({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-T', title: 'target' })],
      binding: { externalId: `${__fixture.M_CHANNEL}:${__fixture.M_ROOT_TS}` },
    });
    const job = {
      id: 'jm',
      tenantId: 'tenant-1',
      type: 'classify' as const,
      attempts: 1,
      payload: __fixture.makeMentionPayload(),
    };

    await handler(job);
    await handler(job);

    const results = await Promise.all(appendOnce.mock.results.map((r) => r.value));
    expect(results.map((r) => r.inserted)).toEqual([true, true, false, false]); // One context row and one human row; neither is repeated.
    expect(enqueueResume).toHaveBeenCalledTimes(2); // never skipped: it is idempotent downstream
    // The mention's own ts is its stable surface message id (rootTs identifies the THREAD, not the reply).
    expect(appendOnce.mock.calls[1]![2]).toMatchObject({
      originMessageId: key(__fixture.M_CHANNEL, '1700000001.0009'),
    });
  });

  test('the same ts in two DIFFERENT channels of one tenant: BOTH side effects land', async () => {
    __fixture.ledgerBackedBump();
    // A Slack `ts` is unique within a CHANNEL, not within a workspace. Keyed on (tenant, ts) alone, the
    // second channel's message would be read as a redelivery of the first and its side effect silently
    // dropped — for a human reply, a permanently lost message.
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const { handler } = __fixture.setup({ verdict: { decision: 'belongs_to', index: 1 }, active });
    const ts = '1699999999.5555';

    await handler(
      __fixture.makeJob({
        payload: __fixture.makeCandidate({ author: 'bot', channel: 'C_ONE', externalId: ts }),
      }),
    );
    await handler(
      __fixture.makeJob({
        payload: __fixture.makeCandidate({ author: 'bot', channel: 'C_TWO', externalId: ts }),
      }),
    );

    const wins = await Promise.all(
      vi.mocked(bumpIncidentOccurrenceOnce).mock.results.map((r) => r.value),
    );
    expect(wins).toEqual([true, true]);
    const keys = vi.mocked(bumpIncidentOccurrenceOnce).mock.calls.map((c) => c[3]);
    expect(keys).toEqual([key('C_ONE', ts), key('C_TWO', ts)]);
  });
});
