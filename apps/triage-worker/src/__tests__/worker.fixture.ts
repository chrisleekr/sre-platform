import Anthropic from '@anthropic-ai/sdk';
import { makeDbAuditSink, type ToolContext, type ToolDefinition } from '@sre/agent-tools';
import type { IDataSourceConnector } from '@sre/connectors';
import type { AutomaticInvestigationBudgetLimits } from '@sre/contracts';
import {
  agentToolCalls,
  approvals,
  createIncident,
  incidentMessages,
  incidentFeedback,
  incidentRelations,
  investigationRuns,
  incidentSignals,
  incidents,
  jobs,
  makeDb,
  serviceDependencies,
  services,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  tenants,
  type DbHandle,
  memberships,
  users,
} from '@sre/db';
import { seedMembership } from '../../../../packages/db/src/test-support';
import type { HubMessage } from '@sre/hub';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { makeFakeEngine } from '../engine/fake';
import { type TriageEngine, type StructuredGenerator } from '../engine/types';
import { makeRedisLock, type IncidentLock } from '../lock';
import { TriageWorker } from '../worker';
import { responderGenerator } from './responder-generator.fixture';

export function createFixture() {
  const recoveryCheck = (
    now: string,
    before = 'Alert threshold exceeded',
    name = 'Current health',
  ) => ({
    name,
    before,
    now,
  });

  const verifyRecovery: TriageEngine['verifyRecovery'] = async (input) => ({
    provider: 'fake',
    sessionId: `fake:${input.incident.id}`,
    model: 'fake',
    outcome: 'conclusive',
    turnBudget: 1,
    disposition: 'recovery',
    summary: 'Recovery was not verified in this test.',
    confidence: 0,
    recovery: {
      recovered: false,
      evidence: [],
      unknowns: ['not exercised'],
      nextStep: null,
    },
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

  let worker: TriageWorker;

  let engineLock: IncidentLock;

  let tenantId: string;
  let actorUserId: string;

  let incidentId: string;

  let claudeIncidentId: string;

  const setLifecycle = (
    targetTenantId: string,
    targetIncidentId: string,
    to: 'open' | 'resolved',
  ) =>
    hub.transitionIncident(targetTenantId, targetIncidentId, {
      to,
      reason: 'Test fixture lifecycle.',
      transitionKey: `test:${targetIncidentId}:${to}`,
      author: 'system',
    });

  // No connectors for this tenant: no per-connector tools are bound.
  const connectorProvider = (): ToolContext['resolveConnectors'] => async () => [];

  // Platform tools bound into every run. Empty here: most tests use a fake engine that ignores tools,
  // and the Claude-loop / binding tests wire their own connector + platform doubles inline.
  const tools: ToolDefinition<any, any>[] = [];

  /** Direct handler tests still need the durable lease used by resume checkpoints. */
  function withResumeLease(value: TriageWorker): TriageWorker {
    const handle = value.handle.bind(value);
    value.handle = async (job, context) => {
      if (job.type === 'resume')
        await admin.db
          .insert(jobs)
          .values({
            id: job.id,
            tenantId: job.tenantId,
            type: job.type,
            payload: job.payload,
            attempts: job.attempts,
            status: 'processing',
            stream: 'direct-worker-fixture',
          })
          .onConflictDoNothing();
      return handle(job, context);
    };
    return value;
  }

  function workerWithEngine(
    engine: TriageEngine,
    options: {
      connectorProvider?: (tenantId: string) => ToolContext['resolveConnectors'];
      getAutomaticInvestigationBudget?: () => Promise<AutomaticInvestigationBudgetLimits>;
      generator?: StructuredGenerator;
      runbookQueue?: Queue;
    } = {},
  ): TriageWorker {
    return withResumeLease(
      new TriageWorker({
        appDb: app.db,
        hub,
        engine,
        generator: options.generator ?? responderGenerator(),
        queue,
        runbookQueue: options.runbookQueue,
        auditSink: makeDbAuditSink({ db: app.db }),
        connectorProvider: options.connectorProvider ?? connectorProvider,
        tools,
        lock: engineLock,
        clearResumeGate: async () => {},
        getAutomaticInvestigationBudget: options.getAutomaticInvestigationBudget,
      }),
    );
  }

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
    // Isolated stream/group so this file never races packages/queue's default-stream tests.
    const queueId = randomUUID();
    queue = new Queue(admin.db, redis, {
      stream: `sre:jobs:triage-test:${queueId}`,
      group: `triage-test:${queueId}`,
    });
    hub = new ConversationHub(app.db, redis);
    engineLock = makeRedisLock(redis);
    worker = withResumeLease(
      new TriageWorker({
        appDb: app.db,
        hub,
        engine: makeFakeEngine(),
        generator: responderGenerator(),
        queue,
        auditSink: makeDbAuditSink({ db: app.db }),
        connectorProvider,
        tools,
        lock: engineLock,
        clearResumeGate: async () => {},
      }),
    );
    await queue.ensureGroup();

    tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'TW' });
    actorUserId = await seedMembership(
      admin.db,
      { issuer: 'https://worker.test/', subject: randomUUID() },
      tenantId,
    );
    incidentId = (
      await createIncident(app.db, tenantId, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    claudeIncidentId = (
      await createIncident(app.db, tenantId, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'checkout',
        severity: 'sev1',
      })
    ).id;
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(jobs).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(agentToolCalls).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(surfaceDeliveries).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentFeedback).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentMessages).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentRelations).where(sql`tenant_id = ${tenantId}`);
      await admin.db
        .update(incidents)
        .set({ recoveryRunId: null, trustedAssessmentRunId: null })
        .where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(investigationRuns).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidentSignals).where(sql`tenant_id = ${tenantId}`);
      // approvals FK -> incidents (tenant-scoped), so clear approvals before the incidents delete.
      await admin.db.delete(approvals).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(surfaceBindings).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(surfaceConfigs).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(serviceDependencies).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(services).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(memberships).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(users).where(sql`id = ${actorUserId}`);
      await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
      await admin.close();
    }
    if (app) await app.close();
    if (redis) await redis.quit();
  });

  // A connector that serves live data, so the degraded brief carries real signal (assembled context).
  function briefConnector(): IDataSourceConnector {
    return {
      id: '00000000-0000-4000-8000-000000000005',
      name: 'Brief GitLab',
      type: 'gitlab',
      snapshot: async () => [],
      fetchTriageContext: async ({ service }) => ({
        source: 'gitlab',
        data: { commits: [{ sha: 'deadbee', title: 'suspect deploy' }], service },
      }),
      tools: () => [],
      probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
    };
  }

  const rateLimited = (): unknown =>
    Anthropic.APIError.generate(429, undefined, 'rate limited', new Headers());

  function msg(id: string, author: string, content: string): HubMessage {
    return {
      id,
      incidentId: 'i',
      author,
      kind: 'text',
      content,
      createdAt: '2026-07-01T00:00:00Z',
    };
  }

  // Same as `msg` but lets a test set `kind` (status/silent/finding/...). Kept separate so the
  // existing 3 tests keep the 3-arg `msg` signature.
  function msgK(id: string, author: string, kind: HubMessage['kind'], content: string): HubMessage {
    return { id, incidentId: 'i', author, kind, content, createdAt: '2026-07-01T00:00:00Z' };
  }

  return {
    get actorUserId() {
      return actorUserId;
    },
    responderGenerator,
    recoveryCheck,
    verifyRecovery,
    ADMIN_URL,
    APP_URL,
    VALKEY_URL,
    get admin() {
      return admin;
    },
    set admin(value: typeof admin) {
      admin = value;
    },
    get app() {
      return app;
    },
    set app(value: typeof app) {
      app = value;
    },
    get redis() {
      return redis;
    },
    set redis(value: typeof redis) {
      redis = value;
    },
    get queue() {
      return queue;
    },
    set queue(value: typeof queue) {
      queue = value;
    },
    get hub() {
      return hub;
    },
    set hub(value: typeof hub) {
      hub = value;
    },
    get worker() {
      return worker;
    },
    set worker(value: typeof worker) {
      worker = value;
    },
    get engineLock() {
      return engineLock;
    },
    set engineLock(value: typeof engineLock) {
      engineLock = value;
    },
    get tenantId() {
      return tenantId;
    },
    set tenantId(value: typeof tenantId) {
      tenantId = value;
    },
    get incidentId() {
      return incidentId;
    },
    set incidentId(value: typeof incidentId) {
      incidentId = value;
    },
    get claudeIncidentId() {
      return claudeIncidentId;
    },
    set claudeIncidentId(value: typeof claudeIncidentId) {
      claudeIncidentId = value;
    },
    setLifecycle,
    connectorProvider,
    tools,
    workerWithEngine,
    briefConnector,
    rateLimited,
    msg,
    msgK,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
