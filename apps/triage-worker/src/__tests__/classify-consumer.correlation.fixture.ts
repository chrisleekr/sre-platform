import { type IncidentSignal, type RouteResult } from '@sre/alerts';
import type { InboundCandidate, MentionCandidate } from '@sre/connectors';
import {
  EMBED_DIM,
  bumpIncidentOccurrenceOnce,
  getBindingByIncident,
  listActiveIncidents,
  retrieveNearestActive,
  type Db,
  type Embedder,
  type IncidentSummary,
} from '@sre/db';
import { type Job, type Queue } from '@sre/queue';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { beforeEach, expect, vi } from 'vitest';
import { makeClassifyHandler } from '../classify-consumer';
import { makeFakeClassifier } from '../engine/classify';
import { type StructuredGenerator } from '../engine/types';

/**
 * A Map-backed Valkey double covering exactly what the inbound side-effect guard uses: SET with NX+EX
 * (reserve, null when already held) and DEL (release). The old stub was `{}` — any guard built on it
 * would have thrown, and no test could have observed a reservation at all.
 */
type FakeRedis = Redis & {
  store: Map<string, string>;
  setKeys: string[];
  delKeys: string[];
};

type Verdict =
  | { decision: 'not_worthy' }
  | { decision: 'belongs_to'; index: number }
  | { decision: 'new_incident'; service: string; severity: string; title: string };

type Deps = Parameters<typeof makeClassifyHandler>[0] & {
  embedder?: Embedder;
  poster?: { post: (...args: unknown[]) => Promise<unknown> };
};

export function createFixture() {
  const CAP_N = 25;

  const RETRIEVE_K = 10;

  const stubDb = {} as unknown as Db;

  function makeFakeRedis(): FakeRedis {
    const store = new Map<string, string>();
    const setKeys: string[] = [];
    const delKeys: string[] = [];
    return {
      store,
      setKeys,
      delKeys,
      async set(key: string, value: string, ...args: unknown[]) {
        const flags = args.map((a) => String(a).toUpperCase());
        setKeys.push(key);
        if (flags.includes('NX') && store.has(key)) return null; // already reserved
        store.set(key, value);
        return 'OK';
      },
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async del(key: string) {
        delKeys.push(key);
        return store.delete(key) ? 1 : 0;
      },
      async eval() {
        return 1;
      },
    } as unknown as FakeRedis;
  }

  const fingerprintFor = (raw: unknown): string =>
    'slack:' + createHash('sha256').update(JSON.stringify(raw)).digest('hex');

  function fakeVector(): number[] {
    return Array.from({ length: EMBED_DIM }, () => 0.01);
  }

  const embedSpy = vi.fn(async (texts: string[]) => texts.map(fakeVector));

  const fakeEmbedder: Embedder = { dim: EMBED_DIM, embed: embedSpy };

  function summary(
    over: Partial<IncidentSummary> & { title?: string; id: string },
  ): IncidentSummary {
    return {
      service: 'checkout',
      severity: 'sev2',
      status: 'open',
      alertSource: 'slack',
      rcaSummary: null,
      confidence: null,
      createdAt: new Date(),
      ...over,
    } as IncidentSummary;
  }

  function mkSummaries(n: number): IncidentSummary[] {
    return Array.from({ length: n }, (_, i) => summary({ id: `inc-${i}`, title: `t${i}` }));
  }

  function makeCandidate(over: Partial<InboundCandidate> = {}): InboundCandidate {
    const externalId = over.externalId ?? '1699999999.0001';
    const author = over.author ?? 'human';
    const text = over.text ?? 'checkout throwing 500s';
    return {
      externalId,
      channel: 'C123',
      author,
      text,
      raw: { ts: '1699999999.0001', text: 'checkout throwing 500s' },
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

  /**
   * A hub double that models the DURABLE idempotency the real hub now has: `appendOnce` is unique on
   * (tenant, originMessageId), so a redelivered append returns the existing line with `inserted:false`
   * instead of writing a second one. `append` (no origin id) stays a plain insert, as in production.
   */
  function fakeHub(idPrefix: string) {
    const rows = new Map<string, { id: string; incidentId: string }>();
    const signals = new Map<string, { id: string; incidentId: string; version: number }>();
    let n = 0;
    const append = vi.fn(async (_t: string, _i: string, _m: unknown) => ({ id: `${idPrefix}` }));
    const insertOnce = async (
      tenantId: string,
      incidentId: string,
      msg: { originMessageId?: string; [key: string]: unknown },
    ) => {
      const key = `${tenantId}:${msg.originMessageId}`;
      const existing = rows.get(key);
      // The unique is on (tenant, origin_message_id) ONLY: the row keeps the incident it was first
      // written to, even if this delivery's verdict named a different one.
      if (existing) return { message: existing, inserted: false };
      n += 1;
      const message = { id: n === 1 ? idPrefix : `${idPrefix}-${n}`, incidentId };
      rows.set(key, message);
      return { message, inserted: true };
    };
    const appendOnce = vi.fn(insertOnce);
    const appendTxOnce = vi.fn(
      async (
        _tx: unknown,
        tenantId: string,
        incidentId: string,
        msg: { originMessageId?: string; [key: string]: unknown },
      ) => insertOnce(tenantId, incidentId, msg),
    );
    const observeSignalTx = vi.fn(
      async (
        _tx: unknown,
        tenantId: string,
        observation: {
          incidentId: string;
          channel: string;
          externalMessageId: string;
          eventKey: string;
        },
        content: string,
      ) => {
        const key = `${tenantId}:${observation.channel}:${observation.externalMessageId}`;
        const existing = signals.get(key);
        if (existing) {
          return {
            observation: { applied: false, allResolved: false, signal: existing },
            message: null,
          };
        }
        const signal = {
          id: `signal-${signals.size + 1}`,
          incidentId: observation.incidentId,
          version: 1,
        };
        signals.set(key, signal);
        const appended = await appendOnce(tenantId, observation.incidentId, {
          author: 'system',
          content,
          originSurface: 'slack',
          originMessageId: observation.eventKey,
        });
        return {
          observation: { applied: true, allResolved: false, signal },
          message: {
            ...appended.message,
            author: 'system',
            kind: 'signal',
            content,
            createdAt: '2026-08-21T00:00:00.000Z',
          },
        };
      },
    );
    const publishAppended = vi.fn(async () => undefined);
    return {
      hub: { appendTxOnce, append, appendOnce, observeSignalTx, publishAppended },
      appendTxOnce,
      append,
      appendOnce,
      observeSignalTx,
      publishAppended,
    };
  }

  /** A ledger-backed bumpIncidentOccurrenceOnce: the (tenant, messageKey) unique decides who bumps, exactly
   *  as the Postgres INSERT ... ON CONFLICT DO NOTHING does. Returns true only for the delivery that won. */
  function ledgerBackedBump(): void {
    const ledger = new Set<string>();
    vi.mocked(bumpIncidentOccurrenceOnce).mockImplementation(
      async (_db: unknown, tenantId: string, _incidentId: string, messageKey: string) => {
        const key = `${tenantId}:${messageKey}`;
        if (ledger.has(key)) return false;
        ledger.add(key);
        return true;
      },
    );
  }

  function setup(opts: {
    verdict: Verdict | ((c: InboundCandidate) => Verdict);
    active?: IncidentSummary[];
    nearest?: IncidentSummary[];
    routeImpl?: (s: IncidentSignal) => Promise<RouteResult>;
    classifyThrows?: Error;
  }) {
    vi.mocked(listActiveIncidents).mockResolvedValue(opts.active ?? []);
    if (opts.nearest) vi.mocked(retrieveNearestActive).mockResolvedValue(opts.nearest);

    // Capture the (candidate, candidates) the consumer hands the classifier.
    const seen: { candidate?: InboundCandidate; candidates?: IncidentSummary[] } = {};
    const classifyFn = vi.fn((candidate: InboundCandidate, candidates?: IncidentSummary[]) => {
      seen.candidate = candidate;
      seen.candidates = candidates;
      if (opts.classifyThrows) throw opts.classifyThrows;
      return typeof opts.verdict === 'function' ? opts.verdict(candidate) : opts.verdict;
    });
    const classify = makeFakeClassifier(classifyFn as never);

    const route = vi.fn(
      opts.routeImpl ??
        (async (): Promise<RouteResult> => ({ deduped: false, incidentId: 'inc-new', jobId: 'j' })),
    );
    const { hub, append, appendOnce, appendTxOnce, observeSignalTx, publishAppended } =
      fakeHub('hub-1');
    const enqueueResume = vi.fn(async (_t: string, _i: string, _m: string) => 'resume-1');
    const insertReassessmentTx = vi.fn(async () => ({ jobId: 'signal-job' }));
    const publishJob = vi.fn(async () => undefined);
    const queue = { enqueueResume, insertReassessmentTx, publishJob } as unknown as Queue;
    // The breadcrumb's destination is STRUCTURAL ({channel, threadId}), never a joined "channel:thread"
    // composite: only the DB's generated external_id owns that delimiter.
    const post = vi.fn(
      async (_t: string, _thread: { channel: string; threadId: string }, _msg: string) => undefined,
    );
    const poster = { post };

    const redis = makeFakeRedis();
    const handler = makeClassifyHandler({
      classify,
      route,
      hub,
      queue,
      embedder: fakeEmbedder,
      poster,
      appDb: stubDb,
      redis,
    } as unknown as Deps);

    return {
      handler,
      route,
      append,
      appendOnce,
      appendTxOnce,
      observeSignalTx,
      publishAppended,
      enqueueResume,
      insertReassessmentTx,
      publishJob,
      post,
      classifyFn,
      seen,
      redis,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Mention pull path correlation (over) ----------------------------------------
  const M_CHANNEL = 'C777';

  const M_ROOT_TS = '1700000001.0001';

  function makeMentionPayload(over: Partial<MentionCandidate> = {}): MentionCandidate {
    return {
      kind: 'mention',
      channel: M_CHANNEL,
      rootTs: M_ROOT_TS,
      ts: '1700000001.0009',
      user: 'U_HUMAN',
      text: '<@U_BOT> checkout is on fire',
      raw: { type: 'app_mention', ts: '1700000001.0009' },
      ...over,
      eventKey: over.eventKey ?? 'slack:C777:1700000001.0009:mention',
    };
  }

  const mentionFingerprint = `slack:${M_CHANNEL}:${M_ROOT_TS}`;

  function setupMention(opts: {
    verdict: Verdict;
    active?: IncidentSummary[];
    binding?: { externalId: string; channel?: string; threadId?: string } | undefined;
    readText?: string;
    routeImpl?: (s: IncidentSignal) => Promise<RouteResult>;
    // resolves the canonical thread's Slack permalink so the breadcrumb can deep-link it. A
    // SEPARATE dep from the (deliberately token-free) BreadcrumbPoster; wired in index.ts next to it.
    resolvePermalink?: (tenantId: string, channel: string, ts: string) => Promise<string | null>;
  }) {
    vi.mocked(listActiveIncidents).mockResolvedValue(opts.active ?? []);
    vi.mocked(getBindingByIncident).mockResolvedValue(opts.binding as never);

    const readThread = vi.fn(async () => [
      { user: 'U_HUMAN', text: opts.readText ?? 'checkout is on fire', ts: M_ROOT_TS },
    ]);
    const threadReader = { readThread };
    const generate = vi.fn(async () => opts.verdict);
    const generator = { generate } as unknown as StructuredGenerator;
    const { hub, append, appendOnce } = fakeHub('hub-m1');
    const enqueueResume = vi.fn(async (_t: string, _i: string, _m: string) => 'resume-m');
    const queue = { enqueueResume } as unknown as Queue;
    const route = vi.fn(
      opts.routeImpl ??
        (async (_s: IncidentSignal): Promise<RouteResult> => ({
          deduped: false,
          incidentId: 'inc-new',
          jobId: 'j',
        })),
    );
    // The breadcrumb's destination is STRUCTURAL ({channel, threadId}), never a joined "channel:thread"
    // composite: only the DB's generated external_id owns that delimiter.
    const post = vi.fn(
      async (_t: string, _thread: { channel: string; threadId: string }, _msg: string) => undefined,
    );
    const poster = { post };
    // Defaults to "unresolvable" so every pre-existing mention test keeps today's generic breadcrumb.
    const resolvePermalink = vi.fn(
      opts.resolvePermalink ?? (async (_t: string, _c: string, _ts: string) => null),
    );

    const redis = makeFakeRedis();
    const handler = makeClassifyHandler({
      classify: makeFakeClassifier((() => ({ decision: 'not_worthy' })) as never),
      route,
      hub,
      threadReader,
      generator,
      queue,
      embedder: fakeEmbedder,
      poster,
      resolvePermalink,
      appDb: stubDb,
      redis,
    } as unknown as Deps);

    return { handler, route, append, appendOnce, enqueueResume, post, redis, resolvePermalink };
  }

  // --- the cross-thread breadcrumb deep-links the canonical thread ---------------------------
  // A cross-thread breadcrumb that only SAYS "tracked in another thread" is a dead end: the human is told
  // their message went somewhere and given no way to get there. Resolve the canonical thread's Slack
  // permalink and render it as an mrkdwn link `<url|text>`.
  //
  // The breadcrumb is the LAST thing the belongs_to path does and it is best-effort by construction, so the
  // permalink lookup inherits that contract: it may fail, return nothing, or have no binding to look up at
  // all — and in every one of those cases the breadcrumb must STILL post (generic), and the classify job
  // must still complete. Silence is the one unacceptable outcome: the human is left with no pointer AND no
  // acknowledgement that their message was consolidated anywhere.
  const CANON_CHANNEL = 'C07ABC123';

  const CANON_TS = '1699999999.000100';

  const CANON_BINDING = {
    channel: CANON_CHANNEL,
    threadId: CANON_TS,
    externalId: `${CANON_CHANNEL}:${CANON_TS}`,
  };

  // Whatever string the resolver handed back — the consumer renders it verbatim and reads nothing out of
  // it, so this fixture asserts no claim about which documented form a thread-root ts actually resolves to
  // (Slack does not specify that; see slackChatGetPermalink). It only has to be a realistic permalink.
  const PERMALINK = `https://acme.slack.com/archives/${CANON_CHANNEL}/p1699999999000100?thread_ts=${CANON_TS}&cid=${CANON_CHANNEL}`;

  const mentionJob = (): Job => ({
    id: 'jm',
    tenantId: 'tenant-1',
    type: 'classify',
    attempts: 1,
    payload: makeMentionPayload(),
  });

  /** The posted breadcrumb text, once the detached best-effort post has landed. */
  async function postedText(post: ReturnType<typeof vi.fn>): Promise<string> {
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    return post.mock.calls[0]![2] as string;
  }

  /** No mrkdwn link anywhere in the text — the generic, link-free breadcrumb. */
  function expectGeneric(text: string): void {
    expect(text).toBeTruthy();
    expect(text).not.toMatch(/<https?:\/\//); // no mrkdwn link
    expect(text).toMatch(/existing incident/i); // still says what happened
  }

  return {
    CAP_N,
    RETRIEVE_K,
    stubDb,
    makeFakeRedis,
    fingerprintFor,
    fakeVector,
    embedSpy,
    fakeEmbedder,
    summary,
    mkSummaries,
    makeCandidate,
    makeJob,
    fakeHub,
    ledgerBackedBump,
    setup,
    M_CHANNEL,
    M_ROOT_TS,
    makeMentionPayload,
    mentionFingerprint,
    setupMention,
    CANON_CHANNEL,
    CANON_TS,
    CANON_BINDING,
    PERMALINK,
    mentionJob,
    postedText,
    expectGeneric,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
