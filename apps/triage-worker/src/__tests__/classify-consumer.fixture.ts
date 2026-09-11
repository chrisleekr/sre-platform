import type { IncidentSignal, RouteResult } from '@sre/alerts';
import type { InboundCandidate } from '@sre/connectors';
import { type Db, type Embedder } from '@sre/db';
import type { Queue } from '@sre/queue';
import { type Job } from '@sre/queue';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { makeClassifyHandler } from '../classify-consumer';
import { makeFakeClassifier, type CorrelationVerdict } from '../engine/classify';
import { type StructuredGenerator } from '../engine/types';
import type { LlmRuntimeManager } from '../llm-runtime';

// --- mention pull path -----------------------------------------------------------------------
// A { kind:'mention' } classify job is a human @-mention: the handler reads the WHOLE thread, opens an
// incident keyed on channel:root_ts, seeds the hub with the verbatim transcript, and NEVER runs the
// worthy classifier (a human is the gate). Thread-read / characterize failures are best-effort — the
// incident still opens. Hermetic: threadReader, generator, hub, route are all injected spies.

type ThreadMessage = { user: string; text: string; ts: string };

type MentionPayload = {
  kind: 'mention';
  intakeId?: string;
  channel: string;
  rootTs: string;
  ts: string;
  user: string;
  text: string;
  raw: unknown;
};

// The mention branch needs three deps the classify path does not: a thread reader, a StructuredGenerator
// (characterize), and a hub for correlated-message appends.
type HubLike = {
  append: (tenantId: string, incidentId: string, msg: unknown) => Promise<unknown>;
  // The idempotent append the correlation paths use: unique on (tenant, originMessageId).
  appendOnce: (
    tenantId: string,
    incidentId: string,
    msg: unknown,
  ) => Promise<{ message: { id: string; incidentId: string }; inserted: boolean }>;
};

type ThreadReader = {
  readThread: (tenantId: string, channel: string, rootTs: string) => Promise<ThreadMessage[]>;
};

type DepsWithMention = Parameters<typeof makeClassifyHandler>[0] & {
  hub?: HubLike;
  threadReader?: ThreadReader;
  generator?: StructuredGenerator;
};

export function createFixture() {
  const FAIL_OPEN_THRESHOLD = 5;

  // job.attempts >= 5 stops redelivering and creates a degraded incident.

  const stubDb = {} as unknown as Db;

  const redisSet = vi.fn(async () => 'OK');

  const redisGet = vi.fn(async () => null as string | null);

  const redisEval = vi.fn(async () => 1);

  const stubRedis = { set: redisSet, get: redisGet, eval: redisEval } as unknown as Redis;

  const stubQueue = {} as unknown as Queue;

  // A deterministic fake embedder for the correlation-shortlist seed (setIncidentEmbedding is mocked, so
  // the vector contents are irrelevant here — only that embed() is callable without a server).
  const fakeEmbedder = {
    dim: 1024,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0])),
  } as unknown as Embedder;

  const fingerprintFor = (raw: unknown): string =>
    'slack:' + createHash('sha256').update(JSON.stringify(raw)).digest('hex');

  function makeCandidate(over: Partial<InboundCandidate> = {}): InboundCandidate {
    const externalId = over.externalId ?? '1699999999.0001';
    const author = over.author ?? 'human';
    const text = over.text ?? 'checkout throwing 500s';
    return {
      externalId,
      channel: 'C123',
      author,
      text,
      raw: { ts: '1699999999.0001', kind: 'message', text: 'checkout throwing 500s' },
      signalState: author === 'bot' ? 'firing' : 'unknown',
      eventKey: `slack:C123:${externalId}`,
      eventAt: '2026-08-21T00:00:00.000Z',
      contentHash: createHash('sha256').update(text).digest('hex'),
      isEdit: false,
      ...over,
    };
  }

  function makeJob(over: Partial<Job> = {}): Job {
    return {
      id: 'job-1',
      tenantId: 'tenant-1',
      type: 'classify',
      attempts: 1,
      payload: makeCandidate(),
      ...over,
    };
  }

  // a Slack-origin incident is BORN bound to the conversation it arrived in — the funnel commits
  // the incident and its surface binding in one transaction. The consumer's job is to carry the origin
  // (channel + thread root) onto the signal; there is no separate best-effort pre-bind to spy on any
  // more, so the route spy IS the binding contract.
  function setup(opts: {
    classifyImpl: (c: InboundCandidate) => CorrelationVerdict | Promise<CorrelationVerdict>;
    routeImpl?: (s: IncidentSignal) => Promise<RouteResult>;
    onOutcomeImpl?: (outcome: unknown) => void | Promise<void>;
    supersededImpl?: (
      tenantId: string,
      intakeId: string,
      eventAt: Date,
      eventVersion?: string,
    ) => Promise<boolean>;
    routingFenceImpl?: <T>(
      tenantId: string,
      intakeId: string,
      eventAt: Date,
      eventVersion: string | undefined,
      identity: { surface: string; channel: string; externalMessageId: string },
      fn: () => Promise<T>,
    ) => Promise<{ status: 'executed'; value: T } | { status: 'superseded' }>;
    llm?: LlmRuntimeManager;
  }) {
    const classifyFn = vi.fn(opts.classifyImpl);
    const classify = makeFakeClassifier(classifyFn);
    const route = vi.fn(
      opts.routeImpl ??
        (async (_s: IncidentSignal): Promise<RouteResult> => ({
          deduped: false,
          incidentId: 'inc-1',
          jobId: 'job-x',
        })),
    );
    const onOutcome = vi.fn(opts.onOutcomeImpl ?? (() => undefined));
    const isIntakeSuperseded = vi.fn(opts.supersededImpl ?? (async () => false));
    const withIntakeRoutingFence = vi.fn(
      opts.routingFenceImpl ??
        (async <T>(
          _tenantId: string,
          _intakeId: string,
          _eventAt: Date,
          _eventVersion: string | undefined,
          _identity: { surface: string; channel: string; externalMessageId: string },
          fn: () => Promise<T>,
        ) => ({
          status: 'executed' as const,
          value: await fn(),
        })),
    );
    const handler = makeClassifyHandler({
      llm: opts.llm,
      classify,
      route,
      embedder: fakeEmbedder,
      appDb: stubDb,
      redis: stubRedis,
      reservationRedis: stubRedis,
      queue: stubQueue,
      isIntakeSuperseded,
      withIntakeRoutingFence: withIntakeRoutingFence as unknown as NonNullable<
        Parameters<typeof makeClassifyHandler>[0]['withIntakeRoutingFence']
      >,
      onOutcome,
    });
    return {
      handler,
      route,
      classifyFn,
      isIntakeSuperseded,
      withIntakeRoutingFence,
      onOutcome,
    };
  }

  /** The conversation origin the handler must put on the signal it routes. */
  const originOf = (route: { mock: { calls: unknown[][] } }, call = 0): unknown =>
    (route.mock.calls[call]![0] as { origin?: unknown }).origin;

  const CHANNEL = 'C777';

  const ROOT_TS = '1700000001.0001';

  const mentionFingerprint = (channel: string, rootTs: string): string =>
    `slack:${channel}:${rootTs}`;

  function makeMentionPayload(over: Partial<MentionPayload> = {}): MentionPayload {
    return {
      kind: 'mention',
      intakeId: 'intake-mention',
      channel: CHANNEL,
      rootTs: ROOT_TS,
      ts: '1700000001.0009',
      user: 'U_HUMAN',
      text: '<@U_BOT> checkout is on fire',
      raw: { type: 'app_mention', ts: '1700000001.0009', text: '<@U_BOT> checkout is on fire' },
      ...over,
    };
  }

  function makeMentionJob(over: Partial<Job> = {}): Job {
    return {
      id: 'job-m',
      tenantId: 'tenant-1',
      type: 'classify',
      attempts: 1,
      payload: makeMentionPayload(),
      ...over,
    };
  }

  function setupMention(
    opts: {
      transcript?: ThreadMessage[];
      readThreadImpl?: ThreadReader['readThread'];
      generateImpl?: (prompt: string, schema: unknown) => Promise<unknown>;
      routeImpl?: (s: IncidentSignal) => Promise<RouteResult>;
      appendOnceImpl?: HubLike['appendOnce'];
      llm?: LlmRuntimeManager;
    } = {},
  ) {
    const readThread = vi.fn(
      opts.readThreadImpl ??
        (async () =>
          opts.transcript ?? [{ user: 'U_HUMAN', text: 'checkout is on fire', ts: ROOT_TS }]),
    );
    const threadReader: ThreadReader = { readThread };

    const generate = vi.fn(
      opts.generateImpl ??
        (async () => ({
          decision: 'new_incident',
          service: 'checkout',
          severity: 'sev2',
          title: 'checkout on fire',
        })),
    );
    const generator = { generate } as unknown as StructuredGenerator;

    const append = vi.fn(
      async (_tenantId: string, _incidentId: string, _msg: unknown): Promise<{ id: string }> => ({
        id: 'hub-m',
      }),
    );
    const appendOnce = vi.fn(
      opts.appendOnceImpl ??
        (async (_t: string, incidentId: string, _m: unknown) => ({
          message: { id: 'hub-m', incidentId },
          inserted: true,
        })),
    );
    const hub: HubLike = { append, appendOnce };

    const route = vi.fn(
      opts.routeImpl ??
        (async (): Promise<RouteResult> => ({
          deduped: false,
          incidentId: 'inc-1',
          jobId: 'job-x',
        })),
    );

    // The correlation classifier MUST NOT run on the mention path (a human is the gate).
    const classifyFn = vi.fn((): CorrelationVerdict => ({ decision: 'not_worthy' }));
    const classify = makeFakeClassifier(classifyFn);
    const onOutcome = vi.fn();
    const enqueueResume = vi.fn(async () => 'resume-job');

    const handler = makeClassifyHandler({
      llm: opts.llm,
      classify,
      route,
      hub,
      threadReader,
      generator,
      embedder: fakeEmbedder,
      appDb: stubDb,
      redis: stubRedis,
      queue: { enqueueResume } as unknown as Queue,
      onOutcome,
    } as unknown as DepsWithMention);

    return {
      handler,
      readThread,
      generate,
      append,
      appendOnce,
      route,
      classifyFn,
      onOutcome,
    };
  }

  return {
    FAIL_OPEN_THRESHOLD,
    stubDb,
    redisSet,
    redisGet,
    redisEval,
    stubRedis,
    stubQueue,
    fakeEmbedder,
    fingerprintFor,
    makeCandidate,
    makeJob,
    setup,
    originOf,
    CHANNEL,
    ROOT_TS,
    mentionFingerprint,
    makeMentionPayload,
    makeMentionJob,
    setupMention,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
