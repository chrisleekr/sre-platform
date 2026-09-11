// the worker interprets human-attached screenshots at turn start — fetch
// transient bytes, run the single vision provider, persist the interpretation, inject it into the
// engine context. Live-PG: seed real incidents + attachments, drive a capturing fake engine.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { responderGenerator } from './responder-generator.fixture';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  makeDb,
  createIncident,
  getIncident,
  recordAttachment,
  attachmentByFileId,
  tenants,
  incidents,
  investigationRuns,
  incidentMessages,
  incidentAttachments,
  jobs,
  type DbHandle,
} from '@sre/db';
import { makeDbAuditSink, type ToolContext, type ToolDefinition } from '@sre/agent-tools';
import { Queue } from '@sre/queue';
import { ConversationHub } from '@sre/hub';
import { TriageWorker, type AttachmentFetcher } from '../worker';
import { makeFakeVision } from '../engine/fake';
import { makeRedisLock } from '../lock';
import type {
  ResumeInput,
  TriageEngine,
  TriageInput,
  TriageResult,
  TriageRuntime,
} from '../engine/types';

const verifyRecovery: TriageEngine['verifyRecovery'] = async (input) => ({
  provider: 'fake',
  sessionId: `fake:${input.incident.id}`,
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

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let queue: Queue;
let hub: ConversationHub;
let tenantId: string;

// Capture the engine context each turn receives so we can assert screenshot injection.
const captured: (string | undefined)[] = [];
const captureEngine: TriageEngine = {
  provider: 'fake',
  verifyRecovery,
  async investigate(input: TriageInput, runtime: TriageRuntime): Promise<TriageResult> {
    captured.push(input.context);
    await runtime.onStep('tool_step', 'looked');
    return {
      provider: 'fake',
      sessionId: `fake:${input.incident.id}`,
      model: 'fake',
      outcome: 'conclusive',
      turnBudget: 1,
      disposition: 'rca',
      summary: 'ok',
      confidence: 50,
    };
  },
  async resume(input: ResumeInput): Promise<TriageResult> {
    captured.push(input.context);
    return {
      provider: 'fake',
      sessionId: `fake:${input.incident.id}`,
      model: 'fake',
      outcome: 'conclusive',
      turnBudget: 1,
      disposition: 'rca',
      summary: 'ok',
      confidence: 50,
    };
  },
};

const connectorProvider = (): ToolContext['resolveConnectors'] => async () => [];
// No connectors and no platform tools wired here; this suite exercises screenshot injection, not tools.
const tools: ToolDefinition<any, any>[] = [];
const bytes = new Uint8Array([1, 2, 3, 4]).buffer;

function makeWorker(fetchAttachment: AttachmentFetcher, supportsVision = true): TriageWorker {
  return new TriageWorker({
    generator: responderGenerator(),
    appDb: app.db,
    hub,
    engine: captureEngine,
    queue,
    auditSink: makeDbAuditSink({ db: app.db }),
    connectorProvider,
    tools,
    lock: makeRedisLock(redis),
    clearResumeGate: async () => {},
    vision: makeFakeVision(supportsVision),
    fetchAttachment,
  });
}

async function drain(worker: TriageWorker): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if ((await worker.tick('mm-worker')) === 0) break;
  }
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  queue = new Queue(admin.db, redis, { stream: 'sre:jobs:mm-test', group: 'mm-test' });
  hub = new ConversationHub(app.db, redis);
  await queue.ensureGroup();
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'MM' });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentAttachments).where(sql`tenant_id = ${tenantId}`);
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
  if (redis) await redis.quit();
});

describe('TriageWorker multimodal', () => {
  test('interprets an image attachment, persists it, injects it into context, and skips on redelivery', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const fileId = `F${randomUUID().slice(0, 8)}`;
    await recordAttachment(app.db, tenantId, {
      incidentId,
      fileId,
      name: 'graph.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/graph.png',
    });
    const fetchAttachment = vi.fn<AttachmentFetcher>(async () => ({
      bytes,
      contentType: 'image/png',
    }));
    const worker = makeWorker(fetchAttachment);

    await queue.enqueue({ tenantId, type: 'triage', payload: { incidentId } });
    await drain(worker);

    // Interpretation persisted on the attachment row.
    const row = await attachmentByFileId(app.db, tenantId, fileId);
    expect(row?.interpretation).toBe('fake interpretation of a image/png image');
    // Injected into the engine context as a "Human-attached screenshots" block.
    const ctx = captured.at(-1);
    expect(ctx).toContain('Human-attached screenshots:');
    expect(ctx).toContain('📎 graph.png: fake interpretation of a image/png image');
    expect(fetchAttachment).toHaveBeenCalledTimes(1);

    // Redelivery: the interpretation-IS-NULL filter means the same file is skipped (no re-fetch).
    await queue.enqueue({ tenantId, type: 'triage', payload: { incidentId } });
    await drain(worker);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });

  test('resume path also interprets a newly-attached screenshot and injects it into the resume context', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const fileId = `F${randomUUID().slice(0, 8)}`;
    await recordAttachment(app.db, tenantId, {
      incidentId,
      fileId,
      name: 'resume-graph.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/resume-graph.png',
    });
    // A human dropped a screenshot with their reply; the resume must interpret + inject it.
    const humanMsg = await hub.append(tenantId, incidentId, {
      author: 'human',
      content: 'see the attached graph',
    });
    const fetchAttachment = vi.fn<AttachmentFetcher>(async () => ({
      bytes,
      contentType: 'image/png',
    }));
    const worker = makeWorker(fetchAttachment);

    await queue.enqueue({
      tenantId,
      type: 'resume',
      payload: { incidentId, humanMessageId: humanMsg.id },
    });
    await drain(worker);

    // The resume engine turn received the screenshots block in its context.
    const ctx = captured.at(-1);
    expect(ctx).toContain('Human-attached screenshots:');
    expect(ctx).toContain('📎 resume-graph.png: fake interpretation of a image/png image');
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });

  test('a fetch failure leaves a reference-only note and the turn still proceeds', async () => {
    const { id: incidentId } = await createIncident(app.db, tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    const fileId = `F${randomUUID().slice(0, 8)}`;
    await recordAttachment(app.db, tenantId, {
      incidentId,
      fileId,
      name: 'broken.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/broken.png',
    });
    const fetchAttachment = vi.fn<AttachmentFetcher>(async () => {
      throw new Error('slack file request failed');
    });
    const worker = makeWorker(fetchAttachment);

    await queue.enqueue({ tenantId, type: 'triage', payload: { incidentId } });
    await drain(worker);

    // Reference-only note persisted (idempotent: not retried every turn) and injected as a placeholder.
    const row = await attachmentByFileId(app.db, tenantId, fileId);
    expect(row?.interpretation).toBe('Screenshot could not be interpreted automatically.');
    const ctx = captured.at(-1);
    expect(ctx).toContain('📎 broken.png: Screenshot could not be interpreted automatically.');
    // The turn proceeded: the engine ran and concluded (RCA persisted).
    const inc = await getIncident(app.db, tenantId, incidentId);
    expect(inc?.rcaSummary).toBe('ok');
  });
});
