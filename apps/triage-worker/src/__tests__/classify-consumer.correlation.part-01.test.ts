import {
  activateSurfaceBinding,
  bumpIncidentOccurrenceOnce,
  getBindingByIncident,
  recordSurfaceBinding,
  retrieveNearestActive,
  setIncidentEmbedding,
} from '@sre/db';

import { RetryableError } from '@sre/queue';

import { describe, expect, test, vi } from 'vitest';

import { ProviderUnavailableError } from '../engine/types';

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

describe('push correlation', () => {
  test('C3 belongs_to a HUMAN message: attaches to the hub + enqueues a resume, no new incident', async () => {
    const active = [
      __fixture.summary({ id: 'inc-A', title: 'A' }),
      __fixture.summary({ id: 'inc-B', title: 'B' }),
    ];
    const { handler, route, appendOnce, enqueueResume, insertReassessmentTx } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active,
    });

    await expect(
      handler(__fixture.makeJob({ payload: __fixture.makeCandidate({ author: 'human' }) })),
    ).resolves.toBeUndefined();

    // Attaches to the resolved candidate (index 1 -> inc-A) and wakes the engine.
    expect(appendOnce).toHaveBeenCalledTimes(1);
    expect(appendOnce.mock.calls[0]![1]).toBe('inc-A');
    expect(enqueueResume).toHaveBeenCalledWith('tenant-1', 'inc-A', 'hub-1');
    expect(insertReassessmentTx).not.toHaveBeenCalled();
    // No new incident, no rebind, no occurrence bump.
    expect(route).not.toHaveBeenCalled();
    expect(vi.mocked(bumpIncidentOccurrenceOnce)).not.toHaveBeenCalled();
  });

  test('C2 belongs_to an automated alert: appends once, bumps occurrence, and reassesses', async () => {
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const { handler, route, appendOnce, enqueueResume, insertReassessmentTx } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active,
    });

    await expect(
      handler(__fixture.makeJob({ payload: __fixture.makeCandidate({ author: 'bot' }) })),
    ).resolves.toBeUndefined();

    expect(vi.mocked(bumpIncidentOccurrenceOnce)).toHaveBeenCalledWith(
      __fixture.stubDb,
      'tenant-1',
      'inc-A',
      'slack:C123:1699999999.0001', // (tenant, channel, ts) — the durable ledger key
    );
    expect(appendOnce).toHaveBeenCalledTimes(1);
    expect(appendOnce.mock.calls[0]![1]).toBe('inc-A');
    expect(appendOnce.mock.calls[0]![2]).toMatchObject({
      author: 'system',
      content: 'checkout throwing 500s',
      originSurface: 'slack',
      originMessageId: 'slack:C123:1699999999.0001',
    });
    expect(enqueueResume).not.toHaveBeenCalled();
    expect(insertReassessmentTx).toHaveBeenCalledWith(
      __fixture.stubDb,
      'tenant-1',
      'inc-A',
      'signal-1',
      1,
      'material_change',
    );
    expect(route).not.toHaveBeenCalled();
  });

  test('an unchanged correlated provider notification updates occurrence without reassessment', async () => {
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const { handler, observeSignalTx, insertReassessmentTx, publishJob } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active,
    });
    observeSignalTx.mockResolvedValueOnce({
      observation: {
        applied: false,
        allResolved: false,
        investigationTriggerReason: 'unchanged_renotification',
        signal: { id: 'signal-active', incidentId: 'inc-A', version: 1 },
      },
      message: null,
    } as never);

    await handler(
      __fixture.makeJob({
        payload: __fixture.makeCandidate({
          author: 'bot',
          observations: [
            {
              externalMessageId: '1699999999.0001#checkout',
              state: 'firing',
              summary: 'Checkout error rate is 12.5%',
              contentHash: 'transport-content',
              eventKey: 'slack:C123:1699999999.0001#checkout',
              eventAt: '2026-08-21T00:00:00.000Z',
              provider: 'prometheus-alertmanager',
              monitorKey: 'slack:C123:alertmanager:checkout-errors:0',
              materialHash: 'stable-material',
              alertName: 'Checkout errors high',
            },
          ],
        }),
      }),
    );

    expect(vi.mocked(bumpIncidentOccurrenceOnce)).toHaveBeenCalledTimes(1);
    expect(insertReassessmentTx).not.toHaveBeenCalled();
    expect(publishJob).not.toHaveBeenCalled();
  });

  test('keeps grouped alert observations distinct and binds the correlated source thread', async () => {
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const { handler, observeSignalTx, insertReassessmentTx, appendTxOnce } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active,
    });
    vi.mocked(getBindingByIncident).mockResolvedValue({
      channel: 'C-primary',
      threadId: '1700000000.0001',
      externalId: 'C-primary:1700000000.0001',
    } as never);
    const candidate = __fixture.makeCandidate({
      author: 'bot',
      observations: [
        {
          externalMessageId: '1699999999.0001#latency',
          state: 'firing',
          summary: 'Checkout latency high',
          contentHash: 'latency-hash',
          eventKey: 'slack:C123:1699999999.0001:latency',
          eventAt: '2026-08-21T00:00:00.000Z',
          provider: 'prometheus-alertmanager',
          alertName: 'Checkout latency high',
        },
        {
          externalMessageId: '1699999999.0001#errors',
          state: 'firing',
          summary: 'Checkout errors high',
          contentHash: 'errors-hash',
          eventKey: 'slack:C123:1699999999.0001:errors',
          eventAt: '2026-08-21T00:00:00.000Z',
          provider: 'prometheus-alertmanager',
          alertName: 'Checkout errors high',
        },
      ],
    });

    await handler(__fixture.makeJob({ payload: candidate }));

    expect(observeSignalTx).toHaveBeenCalledTimes(2);
    expect(observeSignalTx.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({
        externalMessageId: '1699999999.0001#latency',
        alertName: 'Checkout latency high',
      }),
      expect.objectContaining({
        externalMessageId: '1699999999.0001#errors',
        alertName: 'Checkout errors high',
      }),
    ]);
    expect(insertReassessmentTx).toHaveBeenCalledTimes(2);
    expect(recordSurfaceBinding).toHaveBeenCalledWith(
      __fixture.stubDb,
      'tenant-1',
      expect.objectContaining({
        incidentId: 'inc-A',
        role: 'source',
        channel: 'C123',
        threadId: '1699999999.0001',
      }),
    );
    expect(activateSurfaceBinding).toHaveBeenCalledWith(
      __fixture.stubDb,
      'tenant-1',
      'slack',
      'inc-A',
      'source-binding',
    );
    expect(appendTxOnce).not.toHaveBeenCalled();
  });

  test('uses the existing source-thread owner when correlation drifts to another incident', async () => {
    vi.mocked(recordSurfaceBinding).mockResolvedValueOnce({
      id: 'existing-source',
      incidentId: 'inc-thread-owner',
      channel: 'C123',
      threadId: '1699999999.0001',
      externalId: 'C123:1699999999.0001',
      role: 'source',
    } as never);
    const { handler, observeSignalTx, appendTxOnce } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-classifier-choice', title: 'A' })],
    });

    await handler(__fixture.makeJob({ payload: __fixture.makeCandidate({ author: 'bot' }) }));

    expect(observeSignalTx).toHaveBeenCalledWith(
      __fixture.stubDb,
      'tenant-1',
      expect.objectContaining({ incidentId: 'inc-thread-owner' }),
      expect.any(String),
    );
    expect(vi.mocked(bumpIncidentOccurrenceOnce)).toHaveBeenCalledWith(
      __fixture.stubDb,
      'tenant-1',
      'inc-thread-owner',
      'slack:C123:1699999999.0001',
    );
    expect(appendTxOnce).not.toHaveBeenCalled();
  });

  test('a reclaimed older correlation cannot take primary back from a newer thread', async () => {
    const claimedOccurrences = new Set<string>();
    vi.mocked(bumpIncidentOccurrenceOnce).mockImplementation(
      async (_tx, _tenantId, _incidentId, messageKey) => {
        if (claimedOccurrences.has(messageKey)) return false;
        claimedOccurrences.add(messageKey);
        return true;
      },
    );
    vi.mocked(recordSurfaceBinding).mockImplementation(
      async (_tx, _tenantId, input) =>
        ({
          id: `binding-${input.threadId}`,
          incidentId: input.incidentId,
          channel: input.channel,
          threadId: input.threadId,
          externalId: `${input.channel}:${input.threadId}`,
          role: input.role ?? 'primary',
        }) as never,
    );
    const { handler } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-A', title: 'A' })],
    });
    const rootB = __fixture.makeCandidate({ author: 'bot', externalId: 'root-b' });
    const rootC = __fixture.makeCandidate({ author: 'bot', externalId: 'root-c' });

    await handler(__fixture.makeJob({ id: 'job-b-1', payload: rootB }));
    await handler(__fixture.makeJob({ id: 'job-c', payload: rootC }));
    await handler(__fixture.makeJob({ id: 'job-b-2', attempts: 2, payload: rootB }));

    expect(vi.mocked(activateSurfaceBinding).mock.calls.map((call) => call[4])).toEqual([
      'binding-root-b',
      'binding-root-c',
    ]);
  });

  test('C6 a hallucinated index (out of candidate set) falls back to new_incident', async () => {
    const active = [__fixture.summary({ id: 'inc-A', title: 'A' })];
    const raw = { ts: 'evt', text: 'x' };
    const { handler, route, appendOnce } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 99 },
      active,
    });

    await expect(
      handler(__fixture.makeJob({ payload: __fixture.makeCandidate({ raw }) })),
    ).resolves.toBeUndefined();

    // No attach; a NEW incident with the structural per-message fingerprint instead.
    expect(appendOnce).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![0].fingerprint).toBe(__fixture.fingerprintFor(raw));
  });

  test('C5 new_incident: routes a structural-fingerprint incident with title + best-effort seed embedding', async () => {
    const raw = { ts: 'evt-ni', text: 'checkout down' };
    const { handler, route } = __fixture.setup({
      verdict: {
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 'Checkout down',
      },
    });

    await expect(
      handler(__fixture.makeJob({ payload: __fixture.makeCandidate({ raw }) })),
    ).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    const sig = route.mock.calls[0]![0];
    expect(sig.fingerprint).toBe(__fixture.fingerprintFor(raw));
    expect(sig.service).toBe('checkout');
    expect(sig.severity).toBe('sev2');
    expect((sig as { title?: string }).title).toBe('Checkout down');
    // Best-effort seed embedding stored on the created incident.
    expect(__fixture.embedSpy).toHaveBeenCalled();
    expect(vi.mocked(setIncidentEmbedding)).toHaveBeenCalledWith(
      __fixture.stubDb,
      'tenant-1',
      'inc-new',
      expect.anything(),
    );
    // and the routed signal carries the thread it was born in, so the funnel binds it.
    expect(route.mock.calls[0]![0].origin).toMatchObject({ surface: 'slack' });
  });

  test('C5 an embed failure is swallowed: the incident still opens (best-effort)', async () => {
    const { handler, route } = __fixture.setup({
      verdict: { decision: 'new_incident', service: 'checkout', severity: 'sev2', title: 't' },
    });
    __fixture.embedSpy.mockRejectedValueOnce(new Error('embedder down'));

    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setIncidentEmbedding)).not.toHaveBeenCalled();
  });

  test('C7 active set <= CAP_N: passes ALL active incidents, never calls retrieveNearestActive', async () => {
    const active = __fixture.mkSummaries(3);
    const { handler, seen } = __fixture.setup({ verdict: { decision: 'not_worthy' }, active });

    await handler(__fixture.makeJob());

    expect(seen.candidates).toHaveLength(3);
    expect(seen.candidates!.map((c) => c.id)).toEqual(active.map((c) => c.id));
    expect(vi.mocked(retrieveNearestActive)).not.toHaveBeenCalled();
  });

  test('C7 active set > CAP_N: shortlists the top-K via retrieveNearestActive', async () => {
    const active = __fixture.mkSummaries(__fixture.CAP_N + 1); // 26 > cap
    const nearest = __fixture.mkSummaries(__fixture.RETRIEVE_K); // top-K subset
    const { handler, seen } = __fixture.setup({
      verdict: { decision: 'not_worthy' },
      active,
      nearest,
    });

    await handler(__fixture.makeJob());

    expect(vi.mocked(retrieveNearestActive)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(retrieveNearestActive).mock.calls[0]!;
    expect(call[2]).toBe('tenant-1'); // tenant-scoped
    expect((call[3] as { k: number }).k).toBe(__fixture.RETRIEVE_K);
    expect(seen.candidates).toHaveLength(__fixture.RETRIEVE_K);
  });

  test('C10 the candidate text is secret-scrubbed before it reaches the classifier AND the embedder', async () => {
    const SECRET = 'sk-abcdefghijklmnopqrstuvwx1234';
    const { handler, seen } = __fixture.setup({
      verdict: { decision: 'new_incident', service: 'checkout', severity: 'sev2', title: 't' },
    });

    await handler(
      __fixture.makeJob({ payload: __fixture.makeCandidate({ text: `here is ${SECRET}` }) }),
    );

    // The classifier saw scrubbed text.
    expect(seen.candidate!.text).not.toContain(SECRET);
    expect(seen.candidate!.text).toContain('[REDACTED]');
    // The seed the embedder received is scrubbed too.
    const embeddedTexts = __fixture.embedSpy.mock.calls.flatMap((c) => c[0]);
    expect(embeddedTexts.join(' ')).not.toContain(SECRET);
  });

  test('C9 fail-open regression: a sustained provider outage opens a DEGRADED incident; correlation is not consulted', async () => {
    const { handler, route, appendOnce, enqueueResume } = __fixture.setup({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-A', title: 'A' })],
      classifyThrows: new ProviderUnavailableError('anthropic 529'),
    });

    await expect(handler(__fixture.makeJob({ attempts: 5 }))).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect((route.mock.calls[0]![0] as { investigationStatus?: string }).investigationStatus).toBe(
      'degraded',
    );
    // No correlation side effects on the fail-open path.
    expect(appendOnce).not.toHaveBeenCalled();
    expect(enqueueResume).not.toHaveBeenCalled();
    expect(vi.mocked(bumpIncidentOccurrenceOnce)).not.toHaveBeenCalled();
  });

  test('fail-open reuse folds into the owner instead of silently dropping (RouteResult was discarded)', async () => {
    const { handler, route, appendOnce, enqueueResume } = __fixture.setup({
      verdict: { decision: 'not_worthy' }, // unused: classify throws before any verdict
      classifyThrows: new ProviderUnavailableError('anthropic 529'),
      // Fail-open opens a `degraded` incident, but the thread's (thread-derived) fingerprint already
      // owns an ACTIVE incident whose dedup key expired, so the funnel REUSES it and RETURNS
      // {reused:true} rather than throwing ThreadAlreadyBoundError. The worthy path's Site A
      // (classify-consumer.ts:316) folds on this; the fail-open path discards the result.
      routeImpl: async () => ({ deduped: false, incidentId: 'inc-D', reused: true }),
    });

    // A HUMAN message on the fail-open path gives the cleanest fold assertion: attach + resume.
    await expect(
      handler(
        __fixture.makeJob({ attempts: 5, payload: __fixture.makeCandidate({ author: 'human' }) }),
      ),
    ).resolves.toBeUndefined();

    // We are genuinely on the fail-open path (degraded), and the funnel reused inc-D.
    expect(route).toHaveBeenCalledTimes(1);
    expect((route.mock.calls[0]![0] as { investigationStatus?: string }).investigationStatus).toBe(
      'degraded',
    );

    // FOLD: the human joins the reused owner inc-D and the engine is woken. RED under current code —
    // the fail-open path DISCARDS the RouteResult and catches only ThreadAlreadyBoundError, so a
    // reused:true RETURN folds nowhere (no append, no resume).
    expect(appendOnce).toHaveBeenCalledTimes(1);
    expect(appendOnce.mock.calls[0]![1]).toBe('inc-D');
    expect(enqueueResume).toHaveBeenCalledWith('tenant-1', 'inc-D', 'hub-1');
  });

  test('C9 a provider outage below the threshold still redelivers (RetryableError), unchanged', async () => {
    const { handler, route } = __fixture.setup({
      verdict: { decision: 'not_worthy' },
      classifyThrows: new ProviderUnavailableError('anthropic 529'),
    });
    await expect(handler(__fixture.makeJob({ attempts: 1 }))).rejects.toBeInstanceOf(
      RetryableError,
    );
    expect(route).not.toHaveBeenCalled();
  });
});
