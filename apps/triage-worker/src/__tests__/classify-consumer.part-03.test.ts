import { getIncidentLifecycleTx, listSignalsByExternalRoot, listUnresolvedSignals } from '@sre/db';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { makeClassifyHandler } from '../classify-consumer';

import { makeFakeClassifier } from '../engine/classify';

// the classify consumer on the `sre:classify` stream. It runs the
// correlation LLM over the active-incident candidate set, drops not-worthy chatter while preserving
// alert-shaped provider messages, and on a new_incident verdict routes a NEW incident through the
// funnel (routeToIncident). On repeated
// provider outage — or any hard/parse error — it FAILS OPEN to a degraded incident rather than
// dropping the message (degrade-and-redeliver). belongs_to correlation behavior lives
// in classify-consumer.correlation.test.ts; these tests cover the not_worthy / new_incident / fail-open
// / pre-bind / mention-open paths.
//
// Hermetic by construction: the funnel is injected as a `route` collaborator spy, and the @sre/db
// correlation-shortlist reads are mocked (candidate set defaults to empty), so these behavior tests
// need no live Postgres/Valkey. The funnel itself is covered by route-to-incident.test.ts.
vi.mock('@sre/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listActiveIncidents: vi.fn(async () => []),
    retrieveNearestActive: vi.fn(async () => []),
    setIncidentEmbedding: vi.fn(async () => undefined),
    bumpIncidentOccurrenceOnce: vi.fn(async () => true),
    getBindingByIncident: vi.fn(async () => undefined),
    activateSurfaceBinding: vi.fn(async () => undefined),
    getSignalByExternal: vi.fn(async () => undefined),
    listUnresolvedSignals: vi.fn(async () => []),
    listSignalsByExternalRoot: vi.fn(async () => []),
    getIncidentLifecycleTx: vi.fn(async () => ({ status: 'open', version: 0 })),
    prepareResponseGroupRecoveryTx: vi.fn(async (_tx, _tenantId: string, incidentId: string) => ({
      rootIncidentId: incidentId,
      lifecycleVersion: 0,
      signalFence: 'signal-0:2:resolved',
    })),
    withTenant: vi.fn(async (_db, _tenantId, fn: (tx: unknown) => unknown) => fn({})),
  };
});

import { createFixture } from './classify-consumer.fixture';

const __fixture = createFixture();
beforeEach(() => {
  vi.mocked(listUnresolvedSignals).mockReset().mockResolvedValue([]);
  vi.mocked(listSignalsByExternalRoot).mockReset().mockResolvedValue([]);
  vi.mocked(getIncidentLifecycleTx).mockReset().mockResolvedValue({ status: 'open', version: 0 });
});

describe('makeClassifyHandler', () => {
  // --- the inbound 24h dedup window -------------------------------------------
  // The classify consumer must set dedupTtlSec = 86400 on the signal it routes. The window bounds
  // redelivery suppression, NOT flapper correlation: the push-path fingerprint hashes the raw event
  // (which carries a fresh `ts` per message), so a re-firing alert never collides. Correlating a
  // flapper's separate messages is the LLM belongs_to path. The window must apply on BOTH the
  // worthy and the fail-open degraded paths.

  test('does not fall through to the classifier when grouped resolution authority is incomplete', async () => {
    const producerId = 'bot:B_ALERT';
    vi.mocked(listUnresolvedSignals).mockResolvedValueOnce([
      {
        id: 'signal-latency',
        incidentId: 'incident-group',
        channel: 'C123',
        externalMessageId: 'root#latency',
        summary: 'Checkout latency is high',
        service: 'checkout',
        title: null,
        severity: 'sev2',
        alertName: 'Checkout latency is high.',
        providerGroupKey: 'alertmanager:original-group',
        lastEventKey: `slack:C123:root:latency:producer:${producerId}`,
      },
    ] as never);
    const classifyFn = vi.fn(() => ({ decision: 'resolves_signal' as const, signalIndex: 1 }));
    const observeSignalTx = vi.fn();
    const onOutcome = vi.fn();
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(classifyFn),
      route: vi.fn(),
      hub: { observeSignalTx } as never,
      embedder: __fixture.fakeEmbedder,
      appDb: __fixture.stubDb,
      redis: __fixture.stubRedis,
      reservationRedis: __fixture.stubRedis,
      queue: __fixture.stubQueue,
      onOutcome,
    });
    const resolved = __fixture.makeCandidate({
      author: 'bot',
      producerId,
      signalState: 'resolved',
      text: '[RESOLVED:2] unrelated group',
      observations: [
        {
          externalMessageId: 'resolved#latency',
          state: 'resolved',
          summary: 'Checkout latency recovered',
          contentHash: 'latency-resolved',
          eventKey: `slack:C123:resolved:latency:producer:${producerId}`,
          eventAt: '2026-08-21T01:00:00.000Z',
          alertName: 'Checkout latency is high.',
          providerGroupKey: 'alertmanager:different-group',
        },
        {
          externalMessageId: 'resolved#errors',
          state: 'resolved',
          summary: 'Checkout errors recovered',
          contentHash: 'errors-resolved',
          eventKey: `slack:C123:resolved:errors:producer:${producerId}`,
          eventAt: '2026-08-21T01:00:00.000Z',
          alertName: 'Checkout errors are high.',
          providerGroupKey: 'alertmanager:different-group',
        },
      ],
    });

    await handler(__fixture.makeJob({ payload: resolved }));

    expect(classifyFn).not.toHaveBeenCalled();
    expect(observeSignalTx).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
  });

  test('publishes nothing when a later grouped resolution member fails inside the transaction', async () => {
    const producerId = 'bot:B_ALERT';
    vi.mocked(listUnresolvedSignals).mockResolvedValueOnce([
      {
        id: 'signal-a',
        incidentId: 'incident-group',
        channel: 'C123',
        externalMessageId: 'root#a',
        summary: 'A firing',
        service: 'checkout',
        title: null,
        severity: 'sev2',
        alertName: 'Alert A',
        providerGroupKey: 'alertmanager:rollback-group',
        lastEventKey: `slack:C123:root:a:producer:${producerId}`,
      },
      {
        id: 'signal-b',
        incidentId: 'incident-group',
        channel: 'C123',
        externalMessageId: 'root#b',
        summary: 'B firing',
        service: 'checkout',
        title: null,
        severity: 'sev2',
        alertName: 'Alert B',
        providerGroupKey: 'alertmanager:rollback-group',
        lastEventKey: `slack:C123:root:b:producer:${producerId}`,
      },
    ] as never);
    const observeSignalTx = vi
      .fn()
      .mockResolvedValueOnce({
        observation: { applied: true, allResolved: false, signal: { id: 'signal-a', version: 2 } },
        message: { id: 'message-a' },
      })
      .mockRejectedValueOnce(new Error('second observation failed'));
    const publishAppended = vi.fn(async () => undefined);
    const insertRecoveryTx = vi.fn();
    const publishJob = vi.fn();
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => {
        throw new Error('classifier must not run');
      }),
      route: vi.fn(),
      hub: { observeSignalTx, publishAppended } as never,
      embedder: __fixture.fakeEmbedder,
      appDb: __fixture.stubDb,
      redis: __fixture.stubRedis,
      reservationRedis: __fixture.stubRedis,
      queue: { insertRecoveryTx, publishJob } as never,
    });
    const resolved = __fixture.makeCandidate({
      author: 'bot',
      producerId,
      signalState: 'resolved',
      text: '[RESOLVED:2]',
      observations: [
        {
          externalMessageId: 'resolved#a',
          state: 'resolved',
          summary: 'A recovered',
          contentHash: 'a-resolved',
          eventKey: `slack:C123:resolved:a:producer:${producerId}`,
          eventAt: '2026-08-21T01:00:00.000Z',
          alertName: 'Alert A',
          providerGroupKey: 'alertmanager:rollback-group',
        },
        {
          externalMessageId: 'resolved#b',
          state: 'resolved',
          summary: 'B recovered',
          contentHash: 'b-resolved',
          eventKey: `slack:C123:resolved:b:producer:${producerId}`,
          eventAt: '2026-08-21T01:00:00.000Z',
          alertName: 'Alert B',
          providerGroupKey: 'alertmanager:rollback-group',
        },
      ],
    });

    await expect(handler(__fixture.makeJob({ payload: resolved }))).resolves.toBeUndefined();
    expect(observeSignalTx).not.toHaveBeenCalled();
    expect(insertRecoveryTx).not.toHaveBeenCalled();
    expect(publishAppended).not.toHaveBeenCalled();
    expect(publishJob).not.toHaveBeenCalled();
  });

  test('does not revise any durable member from an unverified grouped firing edit', async () => {
    const producerId = 'bot:B_ALERT';
    vi.mocked(listSignalsByExternalRoot).mockResolvedValueOnce([
      {
        incidentId: 'incident-group-edit',
        channel: 'C123',
        externalMessageId: 'root-edit#latency-old',
        alertName: 'Checkout latency is high.',
        providerGroupKey: 'alertmanager:checkout-edit',
      },
      {
        incidentId: 'incident-group-edit',
        channel: 'C123',
        externalMessageId: 'root-edit#errors-old',
        alertName: 'Checkout errors are high.',
        providerGroupKey: 'alertmanager:checkout-edit',
      },
    ] as never);
    const observeSignalTx = vi
      .fn()
      .mockResolvedValueOnce({
        observation: {
          applied: true,
          allResolved: false,
          signal: { id: 'signal-latency', version: 2 },
        },
        message: { id: 'message-latency' },
      })
      .mockResolvedValueOnce({
        observation: {
          applied: true,
          allResolved: false,
          signal: { id: 'signal-errors', version: 2 },
        },
        message: { id: 'message-errors' },
      });
    const insertReassessmentTx = vi.fn(async (_tx, _tenant, _incident, signalId) => ({
      jobId: `reassess-${signalId}`,
    }));
    const publishJob = vi.fn(async () => undefined);
    const publishAppended = vi.fn(async () => undefined);
    const classifyFn = vi.fn(() => {
      throw new Error('a durable grouped edit must bypass classification');
    });
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(classifyFn),
      route: vi.fn(),
      hub: { observeSignalTx, publishAppended } as never,
      embedder: __fixture.fakeEmbedder,
      appDb: __fixture.stubDb,
      redis: __fixture.stubRedis,
      reservationRedis: __fixture.stubRedis,
      queue: {
        insertReassessmentTx,
        insertRecoveryTx: vi.fn(),
        publishJob,
      } as never,
    });
    const edit = __fixture.makeCandidate({
      externalId: 'root-edit',
      author: 'bot',
      producerId,
      isEdit: true,
      signalState: 'firing',
      eventKey: `slack:C123:root-edit:edit:2:producer:${producerId}`,
      observations: [
        {
          externalMessageId: 'root-edit#latency-new',
          state: 'firing',
          summary: 'Checkout latency is now 2 seconds',
          contentHash: 'latency-updated',
          eventKey: `slack:C123:root-edit:edit:2:latency:producer:${producerId}`,
          eventAt: '2026-08-21T01:00:00.000Z',
          eventVersion: '1787274000000001',
          alertName: 'Checkout latency is high.',
          providerGroupKey: 'alertmanager:checkout-edit',
        },
        {
          externalMessageId: 'root-edit#errors-new',
          state: 'firing',
          summary: 'Checkout errors are now 10 percent',
          contentHash: 'errors-updated',
          eventKey: `slack:C123:root-edit:edit:2:errors:producer:${producerId}`,
          eventAt: '2026-08-21T01:00:00.000Z',
          eventVersion: '1787274000000001',
          alertName: 'Checkout errors are high.',
          providerGroupKey: 'alertmanager:checkout-edit',
        },
      ],
    });

    await handler(__fixture.makeJob({ payload: edit }));

    expect(classifyFn).not.toHaveBeenCalled();
    expect(observeSignalTx).not.toHaveBeenCalled();
    expect(insertReassessmentTx).not.toHaveBeenCalled();
    expect(publishJob).not.toHaveBeenCalled();
  });

  test('model resolution receives the newest candidate window but has no lifecycle authority', async () => {
    const producerId = 'bot:B_STATUSCAKE';
    const candidates = Array.from({ length: 26 }, (_, index) => ({
      id: `signal-${index}`,
      incidentId: `incident-${index}`,
      channel: 'C123',
      externalMessageId: `root-${index}`,
      summary: `check-${index}.example.com is down`,
      service: `check-${index}.example.com`,
      title: `check-${index}.example.com down`,
      severity: 'sev2',
      lastEventKey: `slack:C123:root-${index}:producer:${producerId}`,
    }));
    vi.mocked(listUnresolvedSignals).mockResolvedValueOnce(candidates as never);
    vi.mocked(getIncidentLifecycleTx).mockResolvedValueOnce({ status: 'open', version: 0 });
    const observeSignalTx = vi.fn(async () => ({
      observation: {
        applied: true,
        allResolved: true,
        signal: { id: 'signal-1', version: 2 },
      },
      message: null,
    }));
    const classifyFn = vi.fn((_candidate, _incidents, resolutionCandidates) => {
      expect(resolutionCandidates).toHaveLength(25);
      expect(resolutionCandidates[0]).toMatchObject({ id: 'signal-1' });
      expect(resolutionCandidates[24]).toMatchObject({ id: 'signal-25' });
      return { decision: 'resolves_signal' as const, signalIndex: 1 };
    });
    const insertRecoveryTx = vi.fn(async () => ({ jobId: 'recovery-job' }));
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(classifyFn),
      route: vi.fn(),
      hub: { observeSignalTx, publishAppended: async () => {} } as never,
      embedder: __fixture.fakeEmbedder,
      appDb: __fixture.stubDb,
      redis: __fixture.stubRedis,
      reservationRedis: __fixture.stubRedis,
      queue: { insertRecoveryTx, publishJob: vi.fn(async () => {}) } as never,
    });
    const recovery = __fixture.makeCandidate({
      author: 'bot',
      producerId,
      text: 'check-1.example.com recovered and is back online',
    });

    await handler(__fixture.makeJob({ payload: recovery }));

    expect(classifyFn).toHaveBeenCalledTimes(1);
    expect(observeSignalTx).not.toHaveBeenCalled();
    expect(insertRecoveryTx).not.toHaveBeenCalled();
  });

  test('an omitted candidate sharing the selected identity makes model resolution ambiguous', async () => {
    const producerId = 'bot:B_STATUSCAKE';
    const candidates = Array.from({ length: 26 }, (_, index) => ({
      id: `ambiguous-signal-${index}`,
      incidentId: `ambiguous-incident-${index}`,
      channel: 'C123',
      externalMessageId: `ambiguous-root-${index}`,
      summary: `${index <= 1 ? 'shared.example.com' : `check-${index}.example.com`} is down`,
      service: index <= 1 ? 'shared.example.com' : `check-${index}.example.com`,
      title: `${index <= 1 ? 'shared.example.com' : `check-${index}.example.com`} down`,
      severity: 'sev2',
      lastEventKey: `slack:C123:ambiguous-root-${index}:producer:${producerId}`,
    }));
    vi.mocked(listUnresolvedSignals).mockResolvedValueOnce(candidates as never);
    const observeSignalTx = vi.fn();
    const onOutcome = vi.fn();
    const route = vi.fn(async () => ({ deduped: false, incidentId: 'degraded-ambiguous' }));
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier((_candidate, _incidents, resolutionCandidates) => {
        expect(resolutionCandidates[0]).toMatchObject({ id: 'ambiguous-signal-1' });
        return { decision: 'resolves_signal', signalIndex: 1 };
      }),
      route,
      hub: { observeSignalTx } as never,
      embedder: __fixture.fakeEmbedder,
      appDb: __fixture.stubDb,
      redis: __fixture.stubRedis,
      reservationRedis: __fixture.stubRedis,
      queue: __fixture.stubQueue,
      onOutcome,
    });

    await handler(
      __fixture.makeJob({
        payload: __fixture.makeCandidate({
          author: 'bot',
          producerId,
          text: 'shared.example.com recovered',
        }),
      }),
    );

    expect(observeSignalTx).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
  });

  test('a separate resolution from another Slack bot has no mutation authority', async () => {
    vi.mocked(listUnresolvedSignals).mockResolvedValueOnce([
      {
        id: 'signal-producer',
        incidentId: 'incident-producer',
        channel: 'C123',
        externalMessageId: 'root-producer',
        summary:
          '<https://prometheus.example/graph?g0.expr=checkout_errors|[FIRING:1] CheckoutHighErrorRate>',
        service: 'checkout',
        title: null,
        severity: 'sev2',
        lastEventKey: 'slack:C123:root-producer:producer:bot:B_ORIGINAL',
      },
    ] as never);
    const observeSignalTx = vi.fn();
    const insertRecoveryTx = vi.fn();
    const onOutcome = vi.fn();
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => {
        throw new Error('provider classifier must not authorize resolution');
      }),
      route: async () => ({ deduped: false, incidentId: 'unused', jobId: 'unused' }),
      hub: { observeSignalTx } as never,
      embedder: __fixture.fakeEmbedder,
      appDb: __fixture.stubDb,
      redis: __fixture.stubRedis,
      reservationRedis: __fixture.stubRedis,
      queue: { insertRecoveryTx, publishJob: vi.fn() } as never,
      onOutcome,
    });

    await handler(
      __fixture.makeJob({
        payload: __fixture.makeCandidate({
          externalId: 'resolved-wrong-producer',
          author: 'bot',
          producerId: 'bot:B_OTHER',
          text: '<https://prometheus.example/graph?g0.expr=checkout_errors|[RESOLVED] CheckoutHighErrorRate>',
          signalState: 'resolved',
          eventKey: 'slack:C123:resolved-wrong-producer:producer:bot:B_OTHER',
        }),
      }),
    );

    expect(observeSignalTx).not.toHaveBeenCalled();
    expect(insertRecoveryTx).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
  });

  test('an edit enqueued during a not-worthy race stops once the root outcome is terminal', async () => {
    __fixture.redisGet.mockResolvedValueOnce('terminal');
    const onOutcome = vi.fn();
    const observeSignalTx = vi.fn();
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => ({ decision: 'not_worthy' })),
      route: async () => ({ deduped: false, incidentId: 'unused', jobId: 'unused' }),
      hub: { observeSignalTx } as never,
      embedder: __fixture.fakeEmbedder,
      appDb: __fixture.stubDb,
      redis: __fixture.stubRedis,
      reservationRedis: __fixture.stubRedis,
      queue: __fixture.stubQueue,
      onOutcome,
    });

    await expect(
      handler(
        __fixture.makeJob({
          payload: __fixture.makeCandidate({
            author: 'bot',
            isEdit: true,
            eventKey: 'slack:C123:1699999999.0001:edit:2',
          }),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(observeSignalTx).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
  });
});

test.each([
  'missing monitor',
  'conflicting notices',
  'changed monitor edit',
  'legacy edit',
  'matched edit',
])('normalized recovery keeps exact identity authority for %s', async (scenario) => {
  const { slackInboundConnector } = await import('@sre/connectors');
  const notice = (state: 'Up' | 'Down', url = 'https://checkout.example/health') =>
    `Website | Your site '<${url}|checkout>' went ${state} [HTTP ${state === 'Up' ? 200 : 503}]`;
  const read = (text: string, edit = false) => {
    const result = slackInboundConnector.evaluate(
      {
        type: 'message',
        subtype: edit ? 'message_changed' : 'bot_message',
        channel: 'C123',
        ts: '1787991000.000100',
        event_ts: edit ? '1787991100.000100' : '1787991000.000100',
        bot_id: 'B_UPTIME',
        text,
      },
      { botUserId: 'U_PLATFORM' },
    );
    if (result?.disposition !== 'admit') throw new Error('Fixture must be admitted');
    return result.candidate;
  };
  const down = read(notice('Down'));
  const target = {
    ...down.observations![0],
    id: 'target',
    incidentId: 'incident',
    channel: 'C123',
    externalMessageId: down.externalId,
    lastEventKey: down.eventKey,
    service: 'checkout',
    title: 'Checkout down',
    severity: 'sev3',
  };
  const up = read(
    scenario === 'missing monitor'
      ? notice('Up', 'unknown')
      : scenario === 'conflicting notices'
        ? `${notice('Up')}\n${notice('Down', 'https://other.example/health')}`
        : scenario === 'changed monitor edit'
          ? notice('Up', 'https://checkout.example/other')
          : notice('Up'),
    scenario.endsWith('edit'),
  );
  vi.mocked(listUnresolvedSignals).mockResolvedValueOnce([
    scenario === 'legacy edit'
      ? { ...target, monitorKey: null, providerGroupKey: null, provider: null }
      : target,
  ] as never);
  const observeSignalTx = vi.fn(async () => ({
    observation: { applied: true, allResolved: true, signal: { id: 'target', version: 2 } },
    message: null,
  }));
  const insertRecoveryTx = vi.fn(async () => ({ jobId: 'verify' }));
  const classify = vi.fn(() => ({ decision: 'not_worthy' as const }));
  const route = vi.fn();
  const onOutcome = vi.fn();
  const handler = makeClassifyHandler({
    appDb: __fixture.stubDb,
    redis: __fixture.stubRedis,
    reservationRedis: __fixture.stubRedis,
    embedder: __fixture.fakeEmbedder,
    classify: makeFakeClassifier(classify),
    route,
    onOutcome,
    hub: { observeSignalTx, publishAppended: vi.fn() } as never,
    queue: { insertRecoveryTx, publishJob: vi.fn() } as never,
  });
  await handler(__fixture.makeJob({ payload: up }));
  expect(listUnresolvedSignals).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
  expect(route).not.toHaveBeenCalled();
  expect(observeSignalTx).not.toHaveBeenCalled();
  expect(insertRecoveryTx).not.toHaveBeenCalled();
  expect(onOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'resolution_unmatched' }),
  );
});
