import { seedMembership } from '@sre/db/test-support';
import type { NormalizedSnapshot } from '@sre/connectors';
import {
  connectorConfigs,
  createApproval,
  createIncident,
  deployments,
  grantPlatformOperator,
  incidents,
  investigationRuns,
  makeDb,
  makeSecretStore,
  recordGitHubEvent,
  recordSurfaceBinding,
  recordToolCall,
  services,
  serviceRuntimeBindings,
  subscribeChannel,
  syncGitHubRepositories,
  tenants,
  upsertDeployments,
  upsertServiceRepositories,
  upsertSurfaceConfig,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { randomUUID } from 'node:crypto';
import { beforeAll, vi } from 'vitest';
import { makeApp } from '../app';
import { makeTestAuth } from './auth-test-support';
import { registerIncidentFixtureCleanup } from './incidents-fixture/cleanup';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

  const ISSUER = 'https://test.auth0.local/';

  const AUDIENCE = 'sre-api';

  const KID = 'inc-key';

  const KEY = Buffer.alloc(32, 7).toString('base64');
  const state = {
    admin: undefined as unknown as DbHandle,
    app: undefined as unknown as DbHandle,
    api: undefined as unknown as ReturnType<typeof makeApp>,
    redis: undefined as unknown as Redis,
    runbookQueue: undefined as unknown as Queue,
    declarationQueue: undefined as unknown as Queue,
    privateKey: undefined as unknown as CryptoKey,
    orgA: undefined as unknown as string,
    tenantA: undefined as unknown as string,
    orgB: undefined as unknown as string,
    tenantB: undefined as unknown as string,
    orgC: undefined as unknown as string,
    tenantC: undefined as unknown as string,
    runbookIncidentId: undefined as unknown as string,
    hub: undefined as unknown as ConversationHub,
    approvalIncidentId: undefined as unknown as string,
    approvalId: undefined as unknown as string,
    approvalC5IncidentId: undefined as unknown as string,
    approvalC5Id: undefined as unknown as string,
    originIncidentId: undefined as unknown as string,
    originEvidenceId: undefined as unknown as string,
    deliveryMessageId: undefined as unknown as string,
    tenantCUserId: undefined as unknown as string,
    observationDeploymentId: undefined as unknown as string,
    postmortemIncidentId: undefined as unknown as string,
    postmortemRunId: undefined as unknown as string,
  };

  // an incident whose thread lives in a real Slack channel; the list must surface both the channel
  // id (what Slack events carry) and its display name (what the operator recognises).
  const ORIGIN_CHANNEL_ID = 'C07EWAS8132';

  const ORIGIN_CHANNEL_NAME = '#homelab-notification';

  const codeSourceId = randomUUID();

  const observationSourceId = randomUUID();

  const observationEntityId = 'argocd/argocd-server-7d9f';

  const apiLog = { info: vi.fn(), error: vi.fn() };

  const resolveSlackPermalink = vi.fn(
    async () => 'https://company.slack.com/archives/C07EWAS8132/p1783760625776459',
  );

  const observationSnapshots = new Map<string, NormalizedSnapshot[]>();

  const snapshotCache = {
    async get(tenantId: string, source: string) {
      return observationSnapshots.get(`${tenantId}:${source}`) ?? [];
    },
    async set(tenantId: string, source: string, snapshots: NormalizedSnapshot[]) {
      observationSnapshots.set(`${tenantId}:${source}`, snapshots);
    },
  };

  const setLifecycle = (tenantId: string, incidentId: string, to: 'mitigated') =>
    state.hub.transitionIncident(tenantId, incidentId, {
      to,
      reason: 'Test fixture lifecycle.',
      transitionKey: `test:${incidentId}:${to}`,
      author: 'system',
    });

  function sign(org: string): Promise<string> {
    return new SignJWT({ sub: org })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(state.privateKey);
  }

  function auth(token: string) {
    return { headers: { authorization: `Bearer ${token}` } };
  }

  beforeAll(async () => {
    state.admin = makeDb(ADMIN_URL);
    state.app = makeDb(APP_URL);
    const kp = await generateKeyPair('RS256', { extractable: true });
    state.privateKey = kp.privateKey;
    const jwk = await exportJWK(kp.publicKey);
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
    state.redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
    // the runbook-generation queue the generate-runbook route enqueues onto (admin.db like the
    // webhook producer; RLS-bypassing writer that stamps tenantId from the request's tenant context).
    state.runbookQueue = new Queue(state.admin.db, state.redis, {
      stream: 'sre:runbook',
      group: 'runbook-workers',
      deadStream: 'sre:runbook:dead',
    });
    state.declarationQueue = new Queue(state.admin.db, state.redis);
    // the decide route appends a 'decided' reply to the hub; wire a real hub so the
    // route (Phase B) can write and the tests can read history back. Extra dep is cast in below.
    state.hub = new ConversationHub(state.app.db, state.redis);
    state.orgA = `org_${randomUUID().slice(0, 8)}`;
    state.tenantA = randomUUID();
    state.orgB = `org_${randomUUID().slice(0, 8)}`;
    state.tenantB = randomUUID();
    state.orgC = `org_${randomUUID().slice(0, 8)}`;
    state.tenantC = randomUUID();
    await state.admin.db.insert(tenants).values([
      { id: state.tenantA, name: 'A' },
      { id: state.tenantB, name: 'B' },
      { id: state.tenantC, name: 'C' },
    ]);

    await seedMembership(state.admin.db, { issuer: ISSUER, subject: state.orgA }, state.tenantA);
    await seedMembership(state.admin.db, { issuer: ISSUER, subject: state.orgB }, state.tenantB);
    state.tenantCUserId = await seedMembership(
      state.admin.db,
      { issuer: ISSUER, subject: state.orgC },
      state.tenantC,
    );
    await grantPlatformOperator(state.admin.db, state.tenantCUserId);
    const settings = {
      list: async () => [],
      set: async () => 1,
      get: async (key: string) => (key.includes('COST') ? 25 : 100),
      llmRuntime: async () => ({
        config: {
          runtime: 'openai-chat' as const,
          provider: 'openai' as const,
          model: 'test-model',
          baseUrl: null,
          authMode: 'api-key' as const,
          maxTurns: 8,
          pricing: {
            inputPerMTok: 1,
            outputPerMTok: 1,
            cacheReadPerMTok: 1,
            cacheWritePerMTok: 1,
          },
        },
        source: 'stored' as const,
        updatedAt: new Date(),
      }),
    };
    state.api = makeApp({
      auth: await makeTestAuth({
        adminDb: state.admin.db,
        appDb: state.app.db,
        issuer: ISSUER,
        audience: AUDIENCE,
        keys,
        bindings: [
          { tenantId: state.tenantA, subject: state.orgA },
          { tenantId: state.tenantB, subject: state.orgB },
          { tenantId: state.tenantC, subject: state.orgC },
        ],
      }),
      readinessDb: state.app.db,
      appDb: state.app.db,
      secrets: makeSecretStore(state.app.db, KEY),
      cache: snapshotCache,
      settings,
      runbookQueue: state.runbookQueue,
      declarationQueue: state.declarationQueue,
      signalRoute: {
        appDb: state.app.db,
        redis: state.redis,
        queue: state.declarationQueue,
      },
      signalEvaluationQueue: state.declarationQueue,
      signalRuntimeFingerprint: async () => 'test-runtime-fingerprint',
      adminDb: state.admin.db,
      hub: state.hub,
      resumeQueue: state.declarationQueue,
      resolveSlackPermalink,
      log: apiLog,
    } as Parameters<typeof makeApp>[0]);

    const { id: i1 } = await createIncident(state.app.db, state.tenantA, {
      fingerprint: `a1-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    await setLifecycle(state.tenantA, i1, 'mitigated');
    await createIncident(state.app.db, state.tenantA, {
      fingerprint: `a2-${randomUUID()}`,
      alertSource: 'github',
      service: 'api',
      severity: 'sev1',
    });
    await createIncident(state.app.db, state.tenantB, {
      fingerprint: `b1-${randomUUID()}`,
      alertSource: 'aws',
      service: 'db',
      severity: 'sev3',
    });

    // a dedicated tenantC incident for the generate-runbook route tests, isolated so tenants
    // A/B keep their GET /incidents counts.
    state.runbookIncidentId = (
      await createIncident(state.app.db, state.tenantC, {
        fingerprint: `rb-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'payments',
        severity: 'sev2',
      })
    ).id;

    // a tenantC incident with one completed, trusted investigation run that claimed a
    // confidence, so a postmortem pinned to it has a gradable assessment. Own incident, so the
    // generate-runbook tests keep their queue state.
    state.postmortemIncidentId = (
      await createIncident(state.app.db, state.tenantC, {
        fingerprint: `pm-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'payments',
        severity: 'sev2',
      })
    ).id;
    state.postmortemRunId = randomUUID();
    await state.admin.db.insert(investigationRuns).values({
      id: state.postmortemRunId,
      tenantId: state.tenantC,
      incidentId: state.postmortemIncidentId,
      operation: 'investigate',
      outcome: 'conclusive',
      result: {
        summary: 'The connection pool was exhausted.',
        confidence: 85,
        rankedHypotheses: [{ hypothesis: 'Pool exhaustion', confidence: 85, evidence: 'metrics' }],
      },
      completedAt: new Date(),
    });
    await state.admin.db
      .update(incidents)
      .set({
        trustedAssessmentRunId: state.postmortemRunId,
        rcaSummary: 'The connection pool was exhausted.',
        confidence: 85,
      })
      .where(sql`id = ${state.postmortemIncidentId}`);

    // seeds: a pending approval + its linked kind='approval' hub message (the Phase-1
    // emit side) on a dedicated tenantC incident for the decide route, and a second undecided approval on
    // its own incident for the cross-tenant case.
    state.approvalIncidentId = (
      await createIncident(state.app.db, state.tenantC, {
        fingerprint: `ap-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'payments',
        severity: 'sev2',
      })
    ).id;
    const approvalOptions = [
      { id: 'restart', label: 'Restart' },
      { id: 'skip', label: 'Skip' },
    ];
    state.approvalId = (
      await createApproval(state.app.db, state.tenantC, {
        incidentId: state.approvalIncidentId,
        actionId: 'act-restart',
        prompt: 'Restart the service?',
        options: approvalOptions,
      })
    ).row.id;
    await state.hub.append(state.tenantC, state.approvalIncidentId, {
      author: 'agent',
      kind: 'approval',
      content: 'Restart the service?',
      approvalId: state.approvalId,
      approval: { id: state.approvalId, options: approvalOptions },
    });

    state.approvalC5IncidentId = (
      await createIncident(state.app.db, state.tenantC, {
        fingerprint: `ap5-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'payments',
        severity: 'sev3',
      })
    ).id;
    state.approvalC5Id = (
      await createApproval(state.app.db, state.tenantC, {
        incidentId: state.approvalC5IncidentId,
        actionId: 'act-c5',
        prompt: 'Scale up?',
        options: [{ id: 'restart', label: 'Restart' }],
      })
    ).row.id;

    // a tenantC incident born in a real Slack channel — bound to the origin thread, with the
    // channel's display name on its inbound subscription. On tenantC so A/B GET /incidents counts hold.
    state.originIncidentId = (
      await createIncident(state.app.db, state.tenantC, {
        fingerprint: `og-${randomUUID()}`,
        alertSource: 'slack',
        service: 'homelab',
        severity: 'sev3',
      })
    ).id;
    await state.admin.db.insert(connectorConfigs).values({
      id: codeSourceId,
      tenantId: state.tenantC,
      name: 'Incident GitHub',
      type: 'github',
      settings: {},
      enabled: true,
      verificationAttemptedAt: new Date(),
      verificationFailureCategory: 'permission_denied',
    });
    await state.admin.db.insert(connectorConfigs).values({
      id: observationSourceId,
      tenantId: state.tenantC,
      name: 'Primary Kubernetes',
      type: 'kubernetes',
      settings: {},
      enabled: true,
    });
    await snapshotCache.set(state.tenantC, 'kubernetes', [
      {
        tenantId: state.tenantC,
        source: 'kubernetes',
        entityId: observationEntityId,
        metrics: { ready: 1, restartCount: 1, oomKilled: 1 },
        metadata: {
          kind: 'pod',
          namespace: 'argocd',
          phase: 'Running',
          containers: [
            {
              name: 'argocd-server',
              ready: true,
              restartCount: 1,
              terminatedReason: 'OOMKilled',
            },
          ],
          serviceAccountToken: 'must-not-be-persisted',
          error: 'Probe failed with Bearer abc.def.ghi123XYZ',
        },
        observedAt: new Date(),
      },
      {
        tenantId: state.tenantC,
        source: 'kubernetes',
        entityId: 'collection/pods',
        metrics: {},
        metadata: { kind: 'collection', resource: 'pods', completeness: 'complete' },
        observedAt: new Date(),
      },
    ]);
    await upsertDeployments(state.app.db, state.tenantC, [
      {
        source: 'gitlab',
        repo: 'argocd/platform',
        ref: 'main',
        sha: 'badc0de',
        service: 'argocd',
        status: 'failed',
        deployedAt: new Date(),
        url: 'https://user:password@example.test/job?token=must-not-persist#secret',
      },
    ]);
    const [observationDeployment] = await state.admin.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(sql`tenant_id = ${state.tenantC} and repo = 'argocd/platform'`);
    state.observationDeploymentId = observationDeployment!.id;
    await state.admin.db.insert(services).values({
      tenantId: state.tenantC,
      name: 'argocd',
      team: 'platform',
      criticality: 'tier1',
    });
    await state.admin.db.insert(serviceRuntimeBindings).values({
      tenantId: state.tenantC,
      serviceName: 'argocd',
      connectorId: observationSourceId,
      namespace: 'argocd',
      environment: 'test',
      confirmedByUserId: state.tenantCUserId,
      rationale: 'Confirmed fixture runtime',
    });
    await syncGitHubRepositories(state.app.db, state.tenantC, codeSourceId, '7001', [
      {
        installationId: '7001',
        repositoryId: '202',
        owner: 'acme',
        name: 'homelab-service',
        fullName: 'acme/homelab-service',
        defaultBranch: 'main',
        private: true,
        archived: false,
        htmlUrl: 'https://github.com/acme/homelab-service',
      },
    ]);
    await upsertServiceRepositories(state.app.db, state.tenantC, [
      {
        service: 'homelab',
        provider: 'github',
        repositoryFullName: 'acme/homelab-service',
        path: 'services/homelab',
        source: 'argocd',
        confirmed: false,
      },
    ]);
    await recordGitHubEvent(state.app.db, state.tenantC, codeSourceId, {
      deliveryId: randomUUID(),
      eventType: 'push',
      repositoryId: '202',
      repositoryFullName: 'acme/homelab-service',
      actor: 'octocat',
      ref: 'refs/heads/main',
      sha: 'abc123def456',
      summary: { commitCount: 1 },
      occurredAt: new Date(),
    });
    await recordSurfaceBinding(state.app.db, state.tenantC, {
      incidentId: state.originIncidentId,
      surface: 'slack',
      channel: ORIGIN_CHANNEL_ID,
      threadId: '1783760625.776459',
    });
    await subscribeChannel(state.app.db, {
      tenantId: state.tenantC,
      surface: 'slack',
      channel: ORIGIN_CHANNEL_ID,
      channelName: ORIGIN_CHANNEL_NAME,
    });
    await state.admin.db
      .update(incidents)
      .set({
        rcaSummary: 'The database connection pool is saturated.',
        confidence: 81,
        rankedHypotheses: [
          { hypothesis: 'Connection leak', confidence: 81, evidence: 'Active connections rose.' },
        ],
        unknowns: [
          {
            question: 'Whether the last deploy changed pool limits',
            category: 'observable',
            evidenceKind: 'deployment_as_of',
            attemptedEvidenceIds: [],
          },
        ],
        nextStep: 'Compare pool settings across the deploy.',
        assessmentUpdatedAt: new Date('2026-08-21T00:00:00Z'),
      })
      .where(sql`id = ${state.originIncidentId}`);
    state.originEvidenceId = await recordToolCall(state.app.db, state.tenantC, {
      incidentId: state.originIncidentId,
      tool: 'query_metrics',
      input: { service: 'homelab' },
      output: { activeConnections: 100 },
      latencyMs: 12,
      outcome: 'data',
    });
    await upsertSurfaceConfig(state.app.db, state.tenantC, { surface: 'slack' });
    state.deliveryMessageId = (
      await state.hub.append(state.tenantC, state.originIncidentId, {
        author: 'human',
        content: 'Check the connection pool.',
        originSurface: 'dashboard',
        authorUserId: state.tenantCUserId,
        originMessageId: `dashboard:${randomUUID()}`,
      })
    ).id;
  }, 30_000);

  registerIncidentFixtureCleanup(() => ({
    admin: state.admin,
    app: state.app,
    redis: state.redis,
    tenantA: state.tenantA,
    tenantB: state.tenantB,
    tenantC: state.tenantC,
    tenantCUserId: state.tenantCUserId,
    issuer: ISSUER,
    orgA: state.orgA,
    orgB: state.orgB,
    orgC: state.orgC,
  }));
  return Object.assign(state, {
    ADMIN_URL,
    APP_URL,
    VALKEY_URL,
    ISSUER,
    AUDIENCE,
    KID,
    KEY,
    ORIGIN_CHANNEL_ID,
    ORIGIN_CHANNEL_NAME,
    codeSourceId,
    observationSourceId,
    observationEntityId,
    apiLog,
    resolveSlackPermalink,
    observationSnapshots,
    snapshotCache,
    setLifecycle,
    sign,
    auth,
  });
}

export type TestFixture = ReturnType<typeof createFixture>;
