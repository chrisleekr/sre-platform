// Phase A RED for the first-pass snapshot fold + resume reuse. Live-PG +
// Valkey, mirroring worker.test.ts. Covers:
//   C6: an incident whose alertSource matches a connector type → that connector's fetchTriageContext
//       is pulled, redacted, persisted as the FIRST `fetch_triage_context` evidence row, and a TOON
//       evidence is supplied to the investigate request.
//   C7: an incident with no connector origin (alertSource='slack') → no first-pass pull, no snapshot.
//   C8: resume of an incident that already has a `fetch_triage_context` evidence row → the row is
//       reloaded into ResumeInput.evidence (reused, not re-pulled).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { responderGenerator } from './responder-generator.fixture';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  makeDb,
  createIncident,
  recordToolCall,
  withTenant,
  tenants,
  incidents,
  investigationRuns,
  incidentMessages,
  agentToolCalls,
  EVIDENCE_BUDGET_CHARS,
  type DbHandle,
} from '@sre/db';
import { makeDbAuditSink, type ToolDefinition } from '@sre/agent-tools';
import { Queue } from '@sre/queue';
import { ConversationHub } from '@sre/hub';
import type { IDataSourceConnector } from '@sre/connectors';
import { TriageWorker } from '../worker';
import { makeRedisLock, type IncidentLock } from '../lock';
import type {
  ResumeInput,
  TriageEngine,
  TriageInput,
  TriageResult,
  TriageRuntime,
} from '../engine/types';

const verifyRecovery: TriageEngine['verifyRecovery'] = async (input) => ({
  provider: 'capture',
  sessionId: `capture:${input.incident.id}`,
  outcome: 'conclusive',
  turnBudget: 1,
  disposition: 'recovery',
  summary: 'Recovery was not verified in this test.',
  confidence: 0,
  recovery: { recovered: false, evidence: [], unknowns: ['not exercised'], nextStep: null },
});

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

const RAW_SECRET = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const NON_SECRET_MARKER = 'deploy-marker-42';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let queue: Queue;
let hub: ConversationHub;
let engineLock: IncidentLock;
let tenantId: string;

// First-pass seed uses the connector resolver, not the engine tool list, so no platform tools needed.
const tools: ToolDefinition<any, any>[] = [];

// Records the input each engine call receives so the test can assert what the worker assembled.
function makeCapturingEngine(): TriageEngine & {
  lastInvestigate?: TriageInput;
  lastResume?: ResumeInput;
} {
  const engine: TriageEngine & { lastInvestigate?: TriageInput; lastResume?: ResumeInput } = {
    provider: 'capture',
    verifyRecovery,
    async investigate(inputArg: TriageInput, runtime: TriageRuntime): Promise<TriageResult> {
      engine.lastInvestigate = inputArg;
      await runtime.onStep('finding', 'captured investigate');
      return {
        provider: 'capture',
        sessionId: `capture:${inputArg.incident.id}`,
        model: 'capture',
        outcome: 'conclusive',
        turnBudget: 1,
        summary: 'captured',
        confidence: 50,
      };
    },
    async resume(inputArg: ResumeInput, runtime: TriageRuntime): Promise<TriageResult> {
      engine.lastResume = inputArg;
      await runtime.onStep('finding', 'captured resume');
      return {
        provider: 'capture',
        sessionId: `capture:${inputArg.incident.id}`,
        model: 'capture',
        outcome: 'conclusive',
        turnBudget: 1,
        summary: 'captured resume',
        confidence: 55,
      };
    },
  };
  return engine;
}

// A datadog data-source connector whose fetchTriageContext returns secret-bearing data. The
// first-pass seed must redact it before both persist and the model-facing snapshot.
function firstPassConnector(): IDataSourceConnector {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test Datadog',
    type: 'datadog',
    snapshot: async () => [],
    fetchTriageContext: async ({ service }) => ({
      source: 'datadog',
      data: {
        service,
        deploys: [{ changeId: NON_SECRET_MARKER, token: RAW_SECRET }],
        apiKey: RAW_SECRET,
      },
    }),
    tools: () => [],
    probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
  };
}

function makeWorker(opts: {
  engine: TriageEngine;
  connectors: IDataSourceConnector[];
}): TriageWorker {
  return new TriageWorker({
    generator: responderGenerator(),
    appDb: app.db,
    hub,
    engine: opts.engine,
    queue,
    auditSink: makeDbAuditSink({ db: app.db }),
    connectorProvider: () => async () => opts.connectors,
    tools,
    lock: engineLock,
    clearResumeGate: async () => {},
  });
}

async function evidenceRows(incidentId: string) {
  const rows = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(agentToolCalls).where(eq(agentToolCalls.incidentId, incidentId)),
  );
  return rows as Array<(typeof rows)[number] & { output?: unknown; createdAt: Date }>;
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  queue = new Queue(admin.db, redis, {
    stream: 'sre:jobs:evidence-test',
    deadStream: 'sre:jobs:evidence-test:dead',
    group: 'evidence-test',
  });
  hub = new ConversationHub(app.db, redis);
  engineLock = makeRedisLock(redis);
  await queue.ensureGroup();

  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'EV' });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(agentToolCalls).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentMessages).where(sql`tenant_id = ${tenantId}`);
    await admin.db
      .update(incidents)
      .set({ trustedAssessmentRunId: null })
      .where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(investigationRuns).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.close();
  }
  if (app) await app.close();
  if (redis) redis.disconnect();
});

describe('first-pass snapshot seed', () => {
  test('C6 pulls the alertSource connector, persists a redacted first evidence row, appends a TOON snapshot', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const engine = makeCapturingEngine();
    const worker = makeWorker({ engine, connectors: [firstPassConnector()] });

    await queue.enqueue({ tenantId, type: 'triage', payload: { incidentId, alert: { x: 1 } } });
    expect(await worker.tick('c6')).toBe(1);

    // A `fetch_triage_context` evidence row exists, is the ONLY tool row (the capturing engine ran no
    // tools), and carries a redacted output: the non-secret marker survives, the secret does not.
    const rows = await evidenceRows(incidentId);
    const seed = rows.find((r) => r.tool === 'fetch_triage_context')!;
    expect(seed).toBeDefined();
    expect(seed.output).toBeDefined();
    const outputJson = JSON.stringify(seed.output);
    expect(outputJson).toContain(NON_SECRET_MARKER);
    expect(outputJson).not.toContain(RAW_SECRET);
    // First evidence row: earliest createdAt among the incident's tool calls.
    const earliest = rows.slice().sort((a, b) => +a.createdAt - +b.createdAt)[0]!;
    expect(earliest.tool).toBe('fetch_triage_context');

    // The redacted snapshot reached the model through the durable evidence channel.
    const modelEvidence = JSON.stringify(engine.lastInvestigate?.evidence ?? []);
    expect(modelEvidence).toContain(NON_SECRET_MARKER);
    expect(modelEvidence).not.toContain(RAW_SECRET);
  });

  test('C7 skips the first-pass pull for a connector-less origin (alertSource=slack)', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const engine = makeCapturingEngine();
    // No data-source connector for a Slack origin → nothing to pull.
    const worker = makeWorker({ engine, connectors: [] });

    await queue.enqueue({ tenantId, type: 'triage', payload: { incidentId, alert: { x: 1 } } });
    expect(await worker.tick('c7')).toBe(1);

    const rows = await evidenceRows(incidentId);
    expect(rows.some((r) => r.tool === 'fetch_triage_context')).toBe(false);
    expect(engine.lastInvestigate).toBeDefined();
    expect(engine.lastInvestigate?.context ?? '').not.toContain('fetch_triage_context');
  });

  test('C6b best-effort: a failed connector is recorded as unavailable and the incident still opens', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // A matched connector whose fetchTriageContext always throws (e.g. unimplemented / persistent
    // 4xx). The seed must degrade — never poison-loop the triage job.
    const throwing: IDataSourceConnector = {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Unavailable Datadog',
      type: 'datadog',
      snapshot: async () => [],
      fetchTriageContext: async () => {
        throw new Error('connector unavailable');
      },
      tools: () => [],
      probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
    };
    const engine = makeCapturingEngine();
    const worker = makeWorker({ engine, connectors: [throwing] });

    await queue.enqueue({ tenantId, type: 'triage', payload: { incidentId, alert: { x: 1 } } });
    // tick returns 1 (job acked, not rejected/redelivered) and the investigation still ran.
    expect(await worker.tick('c6b')).toBe(1);
    expect(engine.lastInvestigate).toBeDefined();
    const rows = await evidenceRows(incidentId);
    const seed = rows.find((r) => r.tool === 'fetch_triage_context');
    expect(seed?.output).toMatchObject({ sources: [], unavailable: ['datadog'] });
    expect(JSON.stringify(engine.lastInvestigate?.evidence ?? [])).toContain('datadog');
  });
});

describe('first-pass seed is idempotent across redelivery', () => {
  test('C9 a redelivered triage job neither re-fetches the connector nor writes a second seed row', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // Counting connector: proves the guard precedes the (billable) fetch, not just the insert.
    let fetches = 0;
    const base = firstPassConnector();
    const counting: IDataSourceConnector = {
      ...base,
      fetchTriageContext: async (args) => {
        fetches += 1;
        return base.fetchTriageContext!(args);
      },
    };
    const engine = makeCapturingEngine();
    const worker = makeWorker({ engine, connectors: [counting] });

    // Same payload delivered twice (crash-before-ack redelivery / degrade RetryableError path).
    const payload = { incidentId, alert: { x: 1 } };
    await queue.enqueue({ tenantId, type: 'triage', payload });
    expect(await worker.tick('c9')).toBe(1);
    await queue.enqueue({ tenantId, type: 'triage', payload });
    expect(await worker.tick('c9')).toBe(1);

    const rows = await evidenceRows(incidentId);
    expect(rows.filter((r) => r.tool === 'fetch_triage_context').length).toBe(1);
    expect(fetches).toBe(1);

    // The redelivered pass must still receive the first-pass evidence without re-fetching it.
    expect(engine.lastInvestigate?.evidence).toEqual([
      expect.objectContaining({ id: rows[0]!.id, tool: 'fetch_triage_context' }),
    ]);
    const modelEvidence = JSON.stringify(engine.lastInvestigate?.evidence ?? []);
    expect(modelEvidence).toContain(NON_SECRET_MARKER);
    expect(modelEvidence).not.toContain(RAW_SECRET);
  });

  test('a triage job whose seed row is older than the context window RE-SEEDS with fresh data', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    let fetches = 0;
    const base = firstPassConnector();
    const counting: IDataSourceConnector = {
      ...base,
      fetchTriageContext: async (args) => {
        fetches += 1;
        return base.fetchTriageContext!(args);
      },
    };
    const worker = makeWorker({ engine: makeCapturingEngine(), connectors: [counting] });

    await queue.enqueue({ tenantId, type: 'triage', payload: { incidentId, alert: { x: 1 } } });
    expect(await worker.tick('c10')).toBe(1);
    expect(fetches).toBe(1);

    // Age the seed row past the default 60-minute context window. This models the routine re-alert path:
    // once the alert dedup key TTLs out, a re-fire on the same fingerprint reuses the incident and enqueues
    // a FRESH triage job. An existence-only guard would replay the hours-old snapshot as current; the guard
    // is freshness-scoped, so this pass must pull again.
    await withTenant(app.db, tenantId, (tx) =>
      tx
        .update(agentToolCalls)
        .set({ createdAt: sql`now() - interval '3 hours'` })
        .where(eq(agentToolCalls.incidentId, incidentId)),
    );

    await queue.enqueue({ tenantId, type: 'triage', payload: { incidentId, alert: { x: 2 } } });
    expect(await worker.tick('c10')).toBe(1);

    // Two rows / two fetches is CORRECT here: the second is current data, not a duplicate of a live seed.
    const rows = await evidenceRows(incidentId);
    expect(rows.filter((r) => r.tool === 'fetch_triage_context').length).toBe(2);
    expect(fetches).toBe(2);
  });

  test('a seed LARGER than the evidence budget still reaches the redelivered pass', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // The seed bypasses runTool, so TOOL_RESULT_MAX_CHARS never caps it: a routine Datadog/Prometheus
    // window pull can exceed EVIDENCE_BUDGET_CHARS. Reloading it through the budget-bound evidence
    // loader would SKIP the line entirely (used + size > budget) and hand the redelivered pass an empty
    // context, after the freshness guard already suppressed the re-fetch.
    const fat = 'x'.repeat(EVIDENCE_BUDGET_CHARS + 1000);
    const bulky: IDataSourceConnector = {
      ...firstPassConnector(),
      fetchTriageContext: async () => ({
        source: 'datadog',
        data: { marker: NON_SECRET_MARKER, logs: fat },
      }),
    };
    const engine = makeCapturingEngine();
    const worker = makeWorker({ engine, connectors: [bulky] });

    const payload = { incidentId, alert: { x: 1 } };
    await queue.enqueue({ tenantId, type: 'triage', payload });
    expect(await worker.tick('c11')).toBe(1);
    expect(JSON.stringify(engine.lastInvestigate?.evidence ?? [])).toContain(NON_SECRET_MARKER);

    await queue.enqueue({ tenantId, type: 'triage', payload });
    expect(await worker.tick('c11')).toBe(1);

    const rows = await evidenceRows(incidentId);
    expect(rows.filter((r) => r.tool === 'fetch_triage_context').length).toBe(1);
    expect(engine.lastInvestigate?.evidence).toEqual([
      expect.objectContaining({ id: rows[0]!.id, tool: 'fetch_triage_context' }),
    ]);
    expect(JSON.stringify(engine.lastInvestigate?.evidence ?? [])).toContain(NON_SECRET_MARKER);
  });
});

describe('resume reuses the seeded evidence', () => {
  test('C8 reloads a seeded fetch_triage_context row into ResumeInput.evidence, not re-pulled', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // Seed the first-pass evidence row directly (as a prior open would have).
    await recordToolCall(app.db, tenantId, {
      incidentId,
      tool: 'fetch_triage_context',
      input: { service: 'checkout', windowMinutes: 60 },
      latencyMs: 1,
      outcome: 'data',
      output: { source: 'datadog', data: { deploys: [{ changeId: 'deploy-marker-99' }] } },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });

    const humanMsg = await hub.append(tenantId, incidentId, {
      author: 'human',
      content: 'What did the first-pass find?',
    });

    const engine = makeCapturingEngine();
    // No connectors: a resume must reuse the seeded evidence, never re-pull.
    const worker = makeWorker({ engine, connectors: [] });

    await queue.enqueue({
      tenantId,
      type: 'resume',
      payload: { incidentId, humanMessageId: humanMsg.id },
    });
    expect(await worker.tick('c8')).toBe(1);

    const evidence = engine.lastResume?.evidence ?? [];
    expect(evidence.some((e) => e.tool === 'fetch_triage_context')).toBe(true);
  });
});
