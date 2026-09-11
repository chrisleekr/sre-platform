import { listActiveIncidents } from '@sre/db';

import { describe, expect, test, vi } from 'vitest';

import { ProviderRateLimitError, ProviderUnavailableError } from '../engine/types';
import type { LlmRuntimeManager } from '../llm-runtime';

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
    lookupSurfaceIdentity: vi.fn(async () => 'user-human'),
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

const __fixture = createFixture();

describe('makeClassifyHandler provider title fallback', () => {
  test('preserves a rate-limited alert as a degraded incident without retrying classification', async () => {
    const { handler, route, onOutcome } = __fixture.setup({
      classifyImpl: () => {
        throw new ProviderRateLimitError();
      },
    });

    await expect(handler(__fixture.makeJob({ attempts: 1 }))).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![0]).toMatchObject({ investigationStatus: 'degraded' });
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'fail_open' }));
  });

  test('prefers the normalized alert name over transport text', async () => {
    const eventAt = '2026-08-21T00:00:00.000Z';
    const secret = 'sk-abcdefghijklmnopqrstuvwx1234';
    const candidate = __fixture.makeCandidate({
      author: 'bot',
      text: '[FIRING] monitoring notification',
      raw: {
        ts: '1699999999.0001',
        text: `[FIRING] Pod is crash looping. ${secret}`,
        attachments: [{ text: `credential=${secret}` }],
      },
      observations: [
        {
          externalMessageId: '1699999999.0001#0',
          state: 'firing',
          summary: 'Pod api-7d9f is restarting',
          contentHash: 'provider-content',
          eventKey: 'provider-event',
          eventAt,
          provider: 'prometheus-alertmanager',
          alertName: `  Pod is crash looping. ${secret}  `,
        },
      ],
    });
    const { handler, route } = __fixture.setup({
      classifyImpl: () => {
        throw new Error('classifier response was invalid');
      },
    });

    await expect(
      handler(__fixture.makeJob({ payload: candidate, attempts: 0 })),
    ).resolves.toBeUndefined();

    expect(route.mock.calls[0]![0]).toMatchObject({
      title: 'Pod is crash looping. [REDACTED]',
      investigationStatus: 'degraded',
      context: {
        text: '[FIRING] Pod is crash looping. [REDACTED]',
        attachments: [{ text: 'credential=[REDACTED]' }],
      },
      signals: [expect.objectContaining({ alertName: 'Pod is crash looping. [REDACTED]' })],
    });
    expect(JSON.stringify(route.mock.calls[0]![0])).not.toContain(secret);
  });

  test.each([
    ['structural provider fallback', { decision: 'not_worthy' }],
    ['invalid correlation fallback', { decision: 'belongs_to', index: 99 }],
    [
      'classified incident',
      { decision: 'new_incident', service: 'checkout', severity: 'sev2', title: 'Checkout alert' },
    ],
  ] as const)('scrubs raw context on the %s path', async (_name, verdict) => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx1234';
    const candidate = __fixture.makeCandidate({
      author: 'bot',
      alertKind: 'firing',
      text: `[FIRING] Checkout alert ${secret}`,
      raw: {
        text: `[FIRING] Checkout alert ${secret}`,
        attachments: [{ text: `credential=${secret}` }],
      },
    });
    const { handler, route } = __fixture.setup({ classifyImpl: () => verdict });

    await handler(__fixture.makeJob({ payload: candidate }));

    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![0]).toMatchObject({
      context: {
        text: '[FIRING] Checkout alert [REDACTED]',
        attachments: [{ text: 'credential=[REDACTED]' }],
      },
    });
    expect(JSON.stringify(route.mock.calls[0]![0])).not.toContain(secret);
  });
});

describe('makeClassifyHandler mention pull path', () => {
  test('passes the attempt signal to the runtime and rethrows an aborted provider call', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const execute = vi.fn(async (meta, run) => {
      expect(meta.signal).toBe(controller.signal);
      controller.abort(reason);
      return run({
        generator: {
          generate: vi.fn(async () => {
            throw reason;
          }),
        },
      } as never);
    });
    const { handler, route, onOutcome } = __fixture.setupMention({
      llm: { execute } as unknown as LlmRuntimeManager,
    });

    await expect(handler(__fixture.makeMentionJob(), { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(route).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'fail_open' }));
  });

  test('M1 opens an incident with an atomic transcript opener and never runs the worthy classifier', async () => {
    const { handler, readThread, generate, append, route, classifyFn, onOutcome } =
      __fixture.setupMention({
        transcript: [{ user: 'U_HUMAN', text: 'checkout is on fire', ts: __fixture.ROOT_TS }],
      });

    await expect(handler(__fixture.makeMentionJob())).resolves.toBeUndefined();

    // Reads the WHOLE thread by (tenant, channel, rootTs).
    expect(readThread).toHaveBeenCalledWith('tenant-1', __fixture.CHANNEL, __fixture.ROOT_TS);
    // Characterizes via the generator.
    expect(generate).toHaveBeenCalledTimes(1);
    // Bypasses the worthy classifier entirely.
    expect(classifyFn).not.toHaveBeenCalled();

    // Routes an incident keyed on channel:root_ts with the characterized service/severity/title and the
    // rendered transcript as context.
    expect(route).toHaveBeenCalledTimes(1);
    const sig = route.mock.calls[0]![0];
    expect(sig.source).toBe('slack');
    expect(sig.fingerprint).toBe(
      __fixture.mentionFingerprint(__fixture.CHANNEL, __fixture.ROOT_TS),
    );
    expect(sig.service).toBe('checkout');
    expect(sig.severity).toBe('sev2');
    expect((sig as { title?: string }).title).toBe('checkout on fire');
    expect(JSON.stringify(sig.context)).toContain('checkout is on fire');
    expect(sig.investigationTrigger).toEqual({
      reason: 'manual_investigation',
      automatic: false,
      monitorKey: null,
    });

    // Carries the mention's own thread as the incident's origin, so the funnel binds it.
    expect((sig as { origin?: unknown }).origin).toEqual({
      surface: 'slack',
      channel: __fixture.CHANNEL,
      threadId: __fixture.ROOT_TS,
    });

    // The funnel writes the opener on its incident transaction, so no best-effort append follows.
    expect(append).not.toHaveBeenCalled();
    expect(sig.opener).toMatchObject({
      author: 'human',
      authorUserId: 'user-human',
      originSurface: 'slack',
      originMessageId: `slack:${__fixture.CHANNEL}:1700000001.0009`,
    });
    expect((sig.opener as { content: string }).content).toContain('checkout is on fire');
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        intakeId: 'intake-mention',
        outcome: 'mention_new_incident',
      }),
    );
  });

  test('does not record mention completion when opening the incident fails', async () => {
    const { handler, onOutcome } = __fixture.setupMention({
      routeImpl: async () => {
        throw new Error('incident store unavailable');
      },
    });

    await expect(handler(__fixture.makeMentionJob())).rejects.toThrow('classify route failed');
    expect(onOutcome).not.toHaveBeenCalled();
  });

  test('records a correlated mention only after its conversation append succeeds', async () => {
    vi.mocked(listActiveIncidents).mockResolvedValueOnce([
      {
        id: 'inc-existing',
        service: 'checkout',
        severity: 'sev2',
        status: 'open',
        investigationStatus: 'assessed',
        lifecycleVersion: 0,
        alertSource: 'slack',
        title: 'checkout unavailable',
        rcaSummary: null,
        confidence: null,
        archivedAt: null,
        createdAt: new Date('2026-08-29T00:00:00.000Z'),
      },
    ]);
    const { handler, appendOnce, route, onOutcome } = __fixture.setupMention({
      generateImpl: async () => ({ decision: 'belongs_to', index: 1 }),
    });

    await expect(handler(__fixture.makeMentionJob())).resolves.toBeUndefined();

    expect(route).not.toHaveBeenCalled();
    expect(
      appendOnce.mock.calls.filter((call) => (call[2] as { author: string }).author === 'human'),
    ).toHaveLength(1);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        intakeId: 'intake-mention',
        outcome: 'mention_belongs_to',
      }),
    );
  });

  test('does not record a correlated mention when its conversation append fails', async () => {
    vi.mocked(listActiveIncidents).mockResolvedValueOnce([
      {
        id: 'inc-existing',
        service: 'checkout',
        severity: 'sev2',
        status: 'open',
        investigationStatus: 'assessed',
        lifecycleVersion: 0,
        alertSource: 'slack',
        title: 'checkout unavailable',
        rcaSummary: null,
        confidence: null,
        archivedAt: null,
        createdAt: new Date('2026-08-29T00:00:00.000Z'),
      },
    ]);
    const { handler, onOutcome } = __fixture.setupMention({
      generateImpl: async () => ({ decision: 'belongs_to', index: 1 }),
      appendOnceImpl: async () => {
        throw new Error('conversation store unavailable');
      },
    });

    await expect(handler(__fixture.makeMentionJob())).rejects.toThrow(
      'conversation store unavailable',
    );
    expect(onOutcome).not.toHaveBeenCalled();
  });

  test('M2 thread-read failure still opens the incident, falling back to the mention text as context', async () => {
    const { handler, route, append } = __fixture.setupMention({
      readThreadImpl: async () => {
        throw new Error('slack conversations.replies failed');
      },
    });

    await expect(handler(__fixture.makeMentionJob())).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    const sig = route.mock.calls[0]![0];
    expect(sig.fingerprint).toBe(
      __fixture.mentionFingerprint(__fixture.CHANNEL, __fixture.ROOT_TS),
    );
    expect(JSON.stringify(sig.context)).toContain('checkout is on fire');
    // Criterion 7: the atomic opener falls back to the mention text.
    expect(append).not.toHaveBeenCalled();
    expect((sig.opener as { content: string }).content).toContain('checkout is on fire');
  });

  test('M2b empty thread ([] read, null-token case) falls back to the mention text for route + hub', async () => {
    const { handler, route, append } = __fixture.setupMention({ transcript: [] });

    await expect(handler(__fixture.makeMentionJob())).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(route.mock.calls[0]![0].context)).toContain('checkout is on fire');
    expect(append).not.toHaveBeenCalled();
    expect((route.mock.calls[0]![0] as { opener: { content: string } }).opener.content).toContain(
      'checkout is on fire',
    );
  });

  test('M3 characterize failure falls back to channel service, sev3, and the mention text as title', async () => {
    const { handler, route } = __fixture.setupMention({
      generateImpl: async () => {
        throw new Error('generator boom');
      },
    });

    await expect(handler(__fixture.makeMentionJob())).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    const sig = route.mock.calls[0]![0];
    expect(sig.service).toBe(`slack:${__fixture.CHANNEL}`); // serviceForChannel(channel)
    expect(sig.severity).toBe('sev3');
    expect(sig.purpose).toBe('incident');
    expect((sig as { title?: string }).title).toBe('<@U_BOT> checkout is on fire');
  });

  test('M4 the transcript is secret-scrubbed before it reaches route context and the hub', async () => {
    const SECRET = 'sk-abcdefghijklmnopqrstuvwx1234';
    const { handler, route, append } = __fixture.setupMention({
      transcript: [{ user: 'U_HUMAN', text: `here is the key ${SECRET}`, ts: __fixture.ROOT_TS }],
    });

    await expect(handler(__fixture.makeMentionJob())).resolves.toBeUndefined();

    const context = JSON.stringify(route.mock.calls[0]![0].context);
    expect(context).not.toContain(SECRET);
    expect(context).toContain('[REDACTED]');
    expect(append).not.toHaveBeenCalled();
    const hubContent = (route.mock.calls[0]![0].opener as { content: string }).content;
    expect(hubContent).not.toContain(SECRET);
  });

  test('M5 a characterize provider outage is best-effort: the incident opens, not a RetryableError', async () => {
    const { handler, route } = __fixture.setupMention({
      generateImpl: async () => {
        throw new ProviderUnavailableError('anthropic 529 overloaded');
      },
    });

    // Must NOT reject (contrast with the worthy-classify path, which redelivers on a provider outage).
    await expect(handler(__fixture.makeMentionJob())).resolves.toBeUndefined();
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![0].fingerprint).toBe(
      __fixture.mentionFingerprint(__fixture.CHANNEL, __fixture.ROOT_TS),
    );
  });
});
