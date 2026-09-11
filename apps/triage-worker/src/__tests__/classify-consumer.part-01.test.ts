import { listUnresolvedSignals } from '@sre/db';

import { RetryableError } from '@sre/queue';

import { describe, expect, test, vi } from 'vitest';

import { makeClassifyHandler } from '../classify-consumer';

import { makeFakeClassifier } from '../engine/classify';

import { ProviderUnavailableError } from '../engine/types';

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
    incidentSignalFenceTx: vi.fn(async () => 'signal-0:2:resolved'),
    withTenant: vi.fn(async (_db, _tenantId, fn: (tx: unknown) => unknown) => fn({})),
  };
});

import { createFixture } from './classify-consumer.fixture';
import { INTERNAL_REFERENCE } from './internal-reference.fixture';

const __fixture = createFixture();

describe('makeClassifyHandler', () => {
  test.each([
    'Deployment completed successfully for checkout-api',
    'Deployment failed for checkout-api',
    'Acknowledged by the on-call responder',
    'Daily backup completed successfully',
  ])('bot-authored non-alert remains not worthy: %s', async (text) => {
    const { handler, route, onOutcome } = __fixture.setup({
      classifyImpl: () => ({ decision: 'not_worthy' }),
    });

    await expect(
      handler(__fixture.makeJob({ payload: __fixture.makeCandidate({ author: 'bot', text }) })),
    ).resolves.toBeUndefined();

    expect(route).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'not_worthy' }));
  });

  // --- the inbound 24h dedup window -------------------------------------------
  // The classify consumer must set dedupTtlSec = 86400 on the signal it routes. The window bounds
  // redelivery suppression, NOT flapper correlation: the push-path fingerprint hashes the raw event
  // (which carries a fresh `ts` per message), so a re-firing alert never collides. Correlating a
  // flapper's separate messages is the LLM belongs_to path. The window must apply on BOTH the
  // worthy and the fail-open degraded paths.

  const DEDUP_24H_SEC = 24 * 60 * 60;

  test('type guard: a non-classify job is ignored — no classify, no route', async () => {
    const { handler, route, classifyFn } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'x',
        severity: 'sev3',
        title: 'x',
      }),
    });
    await expect(handler(__fixture.makeJob({ type: 'triage' }))).resolves.toBeUndefined();
    expect(classifyFn).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  test('C1 not-worthy: no incident created, no triage enqueued', async () => {
    __fixture.redisEval.mockClear();
    const { handler, route, classifyFn, onOutcome } = __fixture.setup({
      classifyImpl: () => ({ decision: 'not_worthy' }),
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    expect(classifyFn).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();
    expect(__fixture.redisEval).toHaveBeenCalledWith(
      expect.stringContaining('currentVersion'),
      2,
      'classify:msg:tenant-1:C123:1699999999.0001',
      'classify:msg:tenant-1:C123:1699999999.0001:event-version',
      'terminal',
      String(BigInt(Date.parse('2026-08-21T00:00:00.000Z')) * 1000n + 999n),
      '2',
      '86400',
    );
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'not_worthy', messageId: '1699999999.0001' }),
    );
  });

  test('a provider alert in a subscribed channel opens even when the classifier says not worthy', async () => {
    const candidate = __fixture.makeCandidate({
      author: 'bot',
      producerId: 'bot:B_STATUSCAKE',
      alertKind: 'firing',
      intakeId: 'intake-statuscake',
      text: 'SSL certificate expires in 30 days\nRenew before 2026-09-29.',
      observations: [
        {
          externalMessageId: '1699999999.0001',
          state: 'firing',
          summary: 'SSL certificate expires in 30 days',
          contentHash: 'statuscake-content',
          eventKey: 'statuscake-event',
          eventAt: '2026-08-21T00:00:00.000Z',
          provider: 'statuscake',
          alertName: 'Certificate expiry warning',
        },
      ],
    });
    const { handler, route, onOutcome } = __fixture.setup({
      classifyImpl: () => ({ decision: 'not_worthy' }),
    });

    await expect(handler(__fixture.makeJob({ payload: candidate }))).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'slack:C123',
        severity: 'sev3',
        title: 'Certificate expiry warning',
        signals: [
          expect.objectContaining({
            state: 'firing',
            alertName: 'Certificate expiry warning',
            signalSource: expect.objectContaining({
              kind: 'connector',
              provider: 'statuscake',
              externalId: 'bot:B_STATUSCAKE',
            }),
          }),
        ],
      }),
    );
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        intakeId: 'intake-statuscake',
        outcome: 'provider_alert_opened',
      }),
    );
  });

  test('a failed outcome write retries instead of acknowledging completed classification', async () => {
    const { handler, route } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 'checkout unavailable',
      }),
      onOutcomeImpl: async () => {
        throw new Error('outcome store unavailable');
      },
    });

    await expect(handler(__fixture.makeJob())).rejects.toThrow('outcome store unavailable');
    expect(route).toHaveBeenCalledTimes(1);
  });

  test('C2 worthy: routes a slack signal creating a NEW open incident + triage job', async () => {
    const raw = { ts: 'evt-c2', text: 'checkout down' };
    const candidate = __fixture.makeCandidate({ raw, text: 'checkout down' });
    const { handler, route } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 'checkout down',
      }),
    });

    await expect(
      handler(__fixture.makeJob({ tenantId: 'tenant-1', payload: candidate })),
    ).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    const sig = route.mock.calls[0]![0];
    expect(sig.tenantId).toBe('tenant-1');
    expect(sig.source).toBe('slack');
    expect(sig.fingerprint).toBe(__fixture.fingerprintFor(raw));
    expect(sig.service).toBe('checkout');
    expect(sig.severity).toBe('sev2');
    expect(sig.opener).toMatchObject({
      author: 'human',
      content: 'checkout down',
      originSurface: 'slack',
      originMessageId: 'slack:C123:1699999999.0001',
    });
    expect(sig.signals).toEqual([
      expect.objectContaining({
        signalSource: expect.objectContaining({
          kind: 'human_report',
          provider: 'slack',
          externalId: 'slack:C123:human',
        }),
        affectedEntities: [
          expect.objectContaining({
            kind: 'service',
            stableId: 'checkout',
            provenance: { kind: 'classifier_inference', source: 'inbound_classifier' },
          }),
        ],
      }),
    ]);
    // the worthy path threads the classifier title onto the routed signal so the
    // worker can seed runbooks from the incident-open query. RED until the signal sets title:result.title.
    expect((sig as { title?: string }).title).toBe('checkout down');
    // Worthy uses the incident default status (open) — never the degraded fail-open status.
    expect(['open', undefined]).toContain((sig as { status?: string }).status);
  });

  test('an unresolved-signal lookup outage cannot dead-letter an ordinary firing alert', async () => {
    vi.mocked(listUnresolvedSignals).mockRejectedValueOnce(new Error('database unavailable'));
    const { handler, route } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 'checkout is down',
      }),
    });

    await expect(
      handler(
        __fixture.makeJob({
          payload: __fixture.makeCandidate({ author: 'bot', producerId: 'bot:B_PROVIDER' }),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
  });

  test('a provider-neutral recovery retries when signal lookup fails before the retry cap', async () => {
    vi.mocked(listUnresolvedSignals).mockRejectedValueOnce(new Error('database unavailable'));
    const onOutcome = vi.fn();
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => ({ decision: 'not_worthy' })),
      route: vi.fn(),
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
          attempts: __fixture.FAIL_OPEN_THRESHOLD - 1,
          payload: __fixture.makeCandidate({
            author: 'bot',
            producerId: 'bot:B_STATUSCAKE',
            text: 'checkout.example.com went Up with HTTP 200',
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(RetryableError);

    vi.mocked(listUnresolvedSignals).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      handler(
        __fixture.makeJob({
          attempts: __fixture.FAIL_OPEN_THRESHOLD,
          payload: __fixture.makeCandidate({
            author: 'bot',
            producerId: 'bot:B_STATUSCAKE',
            text: 'checkout.example.com went Up with HTTP 200',
          }),
        }),
      ),
    ).resolves.toBeUndefined();
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'not_worthy' }));
  });

  test('an explicit resolution retries candidate lookup transiently, then fails closed at the cap', async () => {
    const onOutcome = vi.fn();
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier(() => {
        throw new Error('classifier must not run without an authorized signal');
      }),
      route: vi.fn(),
      embedder: __fixture.fakeEmbedder,
      appDb: __fixture.stubDb,
      redis: __fixture.stubRedis,
      reservationRedis: __fixture.stubRedis,
      queue: __fixture.stubQueue,
      onOutcome,
    });
    const resolved = __fixture.makeCandidate({
      author: 'bot',
      producerId: 'bot:B_PROVIDER',
      signalState: 'resolved',
      text: '[RESOLVED] checkout latency',
    });
    vi.mocked(listUnresolvedSignals).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      handler(
        __fixture.makeJob({ payload: resolved, attempts: __fixture.FAIL_OPEN_THRESHOLD - 1 }),
      ),
    ).rejects.toBeInstanceOf(RetryableError);

    vi.mocked(listUnresolvedSignals).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      handler(__fixture.makeJob({ payload: resolved, attempts: __fixture.FAIL_OPEN_THRESHOLD })),
    ).resolves.toBeUndefined();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
  });

  test('preserves operational identifiers in model-authored incident identity', async () => {
    const { handler, route } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: '@sre/hub',
        severity: 'sev2',
        title: `ConversationHub.finalizeRecovery() failed per ${INTERNAL_REFERENCE}`,
      }),
    });

    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();

    expect(route.mock.calls[0]![0]).toMatchObject({
      service: '@sre/hub',
      title: `ConversationHub.finalizeRecovery() failed per ${INTERNAL_REFERENCE}`,
    });
  });

  test('C3 provider outage below the fail-open threshold: throws RetryableError, no incident', async () => {
    const { handler, route, onOutcome } = __fixture.setup({
      classifyImpl: () => {
        throw new ProviderUnavailableError('anthropic 529 overloaded');
      },
    });
    await expect(
      handler(__fixture.makeJob({ attempts: __fixture.FAIL_OPEN_THRESHOLD - 1 })),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(route).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'retry', reason: 'provider_unavailable' }),
    );
  });

  test('C4 provider outage at the fail-open threshold: creates a degraded incident and acks', async () => {
    const raw = { ts: 'evt-c4', text: 'db latency' };
    const candidate = __fixture.makeCandidate({ raw, text: 'db latency' });
    const { handler, route, onOutcome } = __fixture.setup({
      classifyImpl: () => {
        throw new ProviderUnavailableError('anthropic 529');
      },
    });

    await expect(
      handler(__fixture.makeJob({ payload: candidate, attempts: __fixture.FAIL_OPEN_THRESHOLD })),
    ).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    const sig = route.mock.calls[0]![0];
    expect(sig.source).toBe('slack');
    expect(sig.fingerprint).toBe(__fixture.fingerprintFor(raw));
    expect(sig.title).toBe('db latency');
    expect((sig as { investigationStatus?: string }).investigationStatus).toBe('degraded');
    expect(sig.opener).toMatchObject({ originMessageId: 'slack:C123:1699999999.0001' });
    expect(sig.signals?.[0]).toMatchObject({
      signalSource: {
        kind: 'human_report',
        provider: 'slack',
        dataSourceId: null,
        externalId: 'slack:C123:human',
        displayName: 'Slack responder',
        observedAt: '2026-08-21T00:00:00.000Z',
      },
    });
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'fail_open', reason: 'provider_unavailable' }),
    );
  });

  test('C4 does not record fail-open completion when degraded incident routing fails', async () => {
    const { handler, onOutcome } = __fixture.setup({
      classifyImpl: () => {
        throw new ProviderUnavailableError('anthropic 529');
      },
      routeImpl: async () => {
        throw new Error('incident store unavailable');
      },
    });

    await expect(
      handler(__fixture.makeJob({ attempts: __fixture.FAIL_OPEN_THRESHOLD })),
    ).rejects.toThrow('classify route failed');
    expect(onOutcome).not.toHaveBeenCalled();
  });

  test('C4 a non-provider (hard/parse) error fails open to a degraded incident at any attempt (never drops)', async () => {
    const { handler, route } = __fixture.setup({
      classifyImpl: () => {
        throw new Error('unexpected parse failure');
      },
    });

    await expect(handler(__fixture.makeJob({ attempts: 0 }))).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect((route.mock.calls[0]![0] as { investigationStatus?: string }).investigationStatus).toBe(
      'degraded',
    );
  });

  test('C5 the same raw yields a stable fingerprint so the funnel dedups to one incident', async () => {
    const raw = { ts: 'evt-c5', text: 'same event' };
    const { handler, route } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'api',
        severity: 'sev3',
        title: 't',
      }),
    });

    await handler(__fixture.makeJob({ payload: __fixture.makeCandidate({ raw }) }));
    await handler(__fixture.makeJob({ payload: __fixture.makeCandidate({ raw }) }));

    expect(route).toHaveBeenCalledTimes(2);
    const first = route.mock.calls[0]![0].fingerprint;
    const second = route.mock.calls[1]![0].fingerprint;
    expect(first).toBe(second);
    expect(first).toBe(__fixture.fingerprintFor(raw));
  });

  test('C8 the redelivery error carries a fixed sanitized message (no provider body, no candidate text)', async () => {
    const SECRET = 'sk-super-secret-token-123';
    const RAW_MARKER = 'RAW_PROVIDER_BODY_MARKER';
    const candidate = __fixture.makeCandidate({
      text: `leak ${SECRET}`,
      raw: { ts: 'evt-c8', text: `leak ${SECRET}`, marker: RAW_MARKER },
    });
    const { handler } = __fixture.setup({
      classifyImpl: () => {
        throw new ProviderUnavailableError(`upstream said ${RAW_MARKER} ${SECRET}`);
      },
    });

    let thrown: unknown;
    try {
      await handler(__fixture.makeJob({ payload: candidate, attempts: 1 }));
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(RetryableError);
    const msg = (thrown as Error).message;
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain(RAW_MARKER);
    expect(msg).not.toContain('leak');
    expect(msg).toBe('classify provider unavailable');
  });

  // --- the incident is born bound to its conversation ------------------------------------
  // The origin (channel + thread root) rides the routed signal, so the funnel can commit the incident
  // and its binding together. Losing the binding would leave an incident the AI can never post about.

  test('worthy create: routes with the alert\u2019s channel + thread root as the origin', async () => {
    const candidate = __fixture.makeCandidate({ channel: 'C777', externalId: '1700000001.0002' });
    const { handler, route } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 't',
      }),
    });

    await expect(
      handler(__fixture.makeJob({ tenantId: 'tenant-1', payload: candidate })),
    ).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect(__fixture.originOf(route)).toEqual({
      surface: 'slack',
      channel: 'C777',
      threadId: '1700000001.0002',
    });
  });

  test('fail-open degraded create: carries the same origin (a degraded incident still has a thread)', async () => {
    const candidate = __fixture.makeCandidate({ channel: 'C888', externalId: '1700000002.0003' });
    const { handler, route } = __fixture.setup({
      classifyImpl: () => {
        throw new ProviderUnavailableError('anthropic 529');
      },
    });

    await expect(
      handler(
        __fixture.makeJob({
          tenantId: 'tenant-1',
          payload: candidate,
          attempts: __fixture.FAIL_OPEN_THRESHOLD,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect(__fixture.originOf(route)).toEqual({
      surface: 'slack',
      channel: 'C888',
      threadId: '1700000002.0003',
    });
  });

  test('not-worthy: no incident, so nothing is routed or bound', async () => {
    const { handler, route } = __fixture.setup({
      classifyImpl: () => ({ decision: 'not_worthy' }),
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    expect(route).not.toHaveBeenCalled();
  });

  test('tenant isolation: routes under the JOB tenant, not a hardcoded constant', async () => {
    // Use a tenant distinct from makeJob's 'tenant-1' default so a regression that hardcoded the
    // tenant (or read it from the untrusted candidate) would fail here.
    const { handler, route } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 't',
      }),
    });

    await expect(handler(__fixture.makeJob({ tenantId: 'tenant-ZZZ' }))).resolves.toBeUndefined();

    expect((route.mock.calls[0]![0] as { tenantId: string }).tenantId).toBe('tenant-ZZZ');
  });

  // 86400

  test('worthy: routes with dedupTtlSec = 86400 (24h dedup window)', async () => {
    const { handler, route } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 't',
      }),
    });

    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect((route.mock.calls[0]![0] as { dedupTtlSec?: number }).dedupTtlSec).toBe(DEDUP_24H_SEC);
  });

  test('fail-open degraded: routes with dedupTtlSec = 86400 (24h dedup window)', async () => {
    const { handler, route } = __fixture.setup({
      classifyImpl: () => {
        throw new ProviderUnavailableError('anthropic 529');
      },
    });

    await expect(
      handler(__fixture.makeJob({ attempts: __fixture.FAIL_OPEN_THRESHOLD })),
    ).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect((route.mock.calls[0]![0] as { dedupTtlSec?: number }).dedupTtlSec).toBe(DEDUP_24H_SEC);
  });
});
