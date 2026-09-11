import { seedMembership } from '@sre/db/test-support';
// Tenant-isolation gate (mirrors incidents.test.ts auth + db-audit-sink.test.ts cross-tenant style),
// live PG (auth org_id -> tenant resolution) + Valkey (the snapshot cache). Proves GET /infrastructure
// and GET /deployments return ONLY the calling tenant's cached snapshots, keyed by the JWT-resolved
// tenant id, never another tenant's — and that the {infrastructure}/{deployments} wrapper the
// dashboard hooks read is shaped correctly.
import type { NormalizedSnapshot } from '@sre/connectors';
import {
  connectorConfigs,
  deployments,
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  tenants,
  upsertDeployments,
  users,
  type DbHandle,
} from '@sre/db';
import { makeSnapshotCache } from '@sre/queue';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { makeApp } from '../app';
import { makeTestAuth } from './auth-test-support';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

  const ISSUER = 'https://test.auth0.local/';

  const AUDIENCE = 'sre-api';

  const KID = 'snap-key';

  const KEY = Buffer.alloc(32, 9).toString('base64');

  let admin: DbHandle;

  let app: DbHandle;

  let redis: Redis;

  let api: ReturnType<typeof makeApp>;

  let privateKey: CryptoKey;

  let orgA: string;

  let tenantA: string;

  let orgB: string;

  let tenantB: string;

  let kubernetesGenerationA: { id: string; lifecycleVersion: number };

  let kubernetesGenerationB: { id: string; lifecycleVersion: number };

  let argoGenerationA: { id: string; lifecycleVersion: number };

  let argoGenerationB: { id: string; lifecycleVersion: number };

  function sign(org: string): Promise<string> {
    return new SignJWT({ sub: org })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  function auth(token: string) {
    return { headers: { authorization: `Bearer ${token}` } };
  }

  function k8sSnap(tenantId: string, entityId: string): NormalizedSnapshot {
    return {
      tenantId,
      source: 'kubernetes',
      entityId,
      metrics: { restartCount: 4, ready: 0, oomKilled: 1 },
      metadata: {
        kind: 'pod',
        namespace: 'checkout',
        phase: 'Running',
        containers: [
          {
            name: 'api',
            ready: false,
            restartCount: 4,
            terminatedReason: 'OOMKilled',
            waitingReason: 'CrashLoopBackOff',
            lastTerminatedReason: 'Error',
            lastTerminatedAt: '2026-06-30T23:55:00Z',
          },
        ],
        serviceAccountToken: 'must-not-leave-the-api',
      },
      observedAt: new Date('2026-07-01T00:00:00Z'),
    };
  }

  function argoSnap(tenantId: string, name: string): NormalizedSnapshot {
    return {
      tenantId,
      source: 'argocd',
      entityId: `application:payments/argocd/${name}`,
      metrics: {},
      metadata: {
        kind: 'application',
        applicationId: `payments/argocd/${name}`,
        applicationName: name,
        applicationNamespace: 'argocd',
        project: 'payments',
        syncStatus: 'OutOfSync',
        healthStatus: 'Degraded',
        operationPhase: 'Running',
        revisions: ['app-revision', 'config-revision'],
        destinationServer: 'https://kubernetes.default.svc',
        destinationNamespace: 'payments',
        conditions: [{ type: 'ComparisonError', message: 'render failed' }],
        token: 'must-not-leave-the-api',
      },
      observedAt: new Date('2026-08-22T01:00:00Z'),
    };
  }

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
    const kp = await generateKeyPair('RS256', { extractable: true });
    privateKey = kp.privateKey;
    const jwk = await exportJWK(kp.publicKey);
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
    const cache = makeSnapshotCache(redis);
    orgA = `org_${randomUUID().slice(0, 8)}`;
    tenantA = randomUUID();
    orgB = `org_${randomUUID().slice(0, 8)}`;
    tenantB = randomUUID();
    await admin.db.insert(tenants).values([
      { id: tenantA, name: 'A' },
      { id: tenantB, name: 'B' },
    ]);
    await seedMembership(admin.db, { issuer: ISSUER, subject: orgA }, tenantA);
    await seedMembership(admin.db, { issuer: ISSUER, subject: orgB }, tenantB);
    api = makeApp({
      auth: await makeTestAuth({
        adminDb: admin.db,
        appDb: app.db,
        issuer: ISSUER,
        audience: AUDIENCE,
        keys,
        bindings: [
          { tenantId: tenantA, subject: orgA },
          { tenantId: tenantB, subject: orgB },
        ],
      }),
      readinessDb: app.db,
      appDb: app.db,
      secrets: makeSecretStore(app.db, KEY),
      cache,
      settings: { list: async () => [], set: async () => 1 },
    });
    const argoConfigs = await admin.db
      .insert(connectorConfigs)
      .values([
        {
          tenantId: tenantA,
          name: 'Tenant A Argo CD',
          type: 'argocd',
          settings: {},
          enabled: true,
          verificationSucceededAt: new Date('2026-08-22T00:00:00Z'),
          pollSucceededAt: new Date('2026-08-22T00:30:00Z'),
        },
        {
          tenantId: tenantB,
          name: 'Tenant B Argo CD',
          type: 'argocd',
          settings: {},
          enabled: true,
          verificationSucceededAt: new Date('2026-08-22T00:00:00Z'),
          pollSucceededAt: new Date('2026-08-22T00:30:00Z'),
        },
        {
          tenantId: tenantA,
          name: 'Tenant A Kubernetes',
          type: 'kubernetes',
          settings: {},
          enabled: true,
        },
        {
          tenantId: tenantB,
          name: 'Tenant B Kubernetes',
          type: 'kubernetes',
          settings: {},
          enabled: true,
        },
      ])
      .returning({
        id: connectorConfigs.id,
        lifecycleVersion: connectorConfigs.lifecycleVersion,
        tenantId: connectorConfigs.tenantId,
      });
    argoGenerationA = argoConfigs.find((row) => row.tenantId === tenantA)!;
    argoGenerationB = argoConfigs.find((row) => row.tenantId === tenantB)!;
    kubernetesGenerationA = argoConfigs.find(
      (row) => row.tenantId === tenantA && row.id !== argoGenerationA.id,
    )!;
    kubernetesGenerationB = argoConfigs.find(
      (row) => row.tenantId === tenantB && row.id !== argoGenerationB.id,
    )!;

    // /infrastructure serves the kubernetes snapshot cache, keyed by the JWT-resolved tenant.
    await cache.set(tenantA, 'kubernetes', [k8sSnap(tenantA, 'pod-a')], 60, kubernetesGenerationA);
    await cache.set(tenantB, 'kubernetes', [k8sSnap(tenantB, 'pod-b')], 60, kubernetesGenerationB);
    await cache.set(tenantA, 'argocd', [argoSnap(tenantA, 'checkout')], 60, argoGenerationA);
    await cache.set(tenantB, 'argocd', [argoSnap(tenantB, 'orders')], 60, argoGenerationB);
    // /deployments serves the durable `deployments` table, NOT the cache. Seed one deploy per
    // tenant mirroring what the poller would persist; the route reads these strictly under RLS.
    await upsertDeployments(app.db, tenantA, [
      {
        source: 'gitlab',
        repo: '71',
        ref: 'main',
        sha: 'deadbeef',
        service: null,
        status: 'failed',
        url: 'https://gl/p/42',
        deployedAt: new Date('2026-07-01T00:05:00Z'),
      },
    ]);
    await upsertDeployments(app.db, tenantA, [
      {
        source: 'argocd',
        providerId: 'uid-checkout:7',
        repo: 'payments/argocd/checkout',
        ref: 'main, config-main',
        sha: 'release-app',
        revisions: ['release-app', 'release-config'],
        operationPhase: 'Succeeded',
        service: 'checkout',
        status: 'success',
        deployedAt: new Date('2026-07-01T00:06:00Z'),
      },
    ]);
    await upsertDeployments(app.db, tenantB, [
      {
        source: 'gitlab',
        repo: '71',
        ref: 'main',
        sha: 'cafe99',
        service: null,
        status: 'failed',
        url: 'https://gl/p/99',
        deployedAt: new Date('2026-07-01T00:05:00Z'),
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    if (redis) {
      await redis.del(
        `snap:${tenantA}:kubernetes`,
        `snap:${tenantA}:gitlab`,
        `snap:${tenantB}:kubernetes`,
        `snap:${tenantB}:gitlab`,
        `snap:${tenantA}:argocd`,
        `snap:${tenantB}:argocd`,
        `snap:${tenantA}:kubernetes:${kubernetesGenerationA.id}:${kubernetesGenerationA.lifecycleVersion}`,
        `snap:${tenantB}:kubernetes:${kubernetesGenerationB.id}:${kubernetesGenerationB.lifecycleVersion}`,
        `snap:${tenantA}:argocd:${argoGenerationA.id}:${argoGenerationA.lifecycleVersion}`,
        `snap:${tenantB}:argocd:${argoGenerationB.id}:${argoGenerationB.lifecycleVersion}`,
      );
      await redis.quit();
    }
    if (admin) {
      await admin.db.delete(deployments).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(connectorConfigs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db
        .delete(tenantIdentityBindings)
        .where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(users).where(sql`issuer = ${ISSUER} and subject in (${orgA}, ${orgB})`);
      await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
      await admin.close();
    }
    if (app) await app.close();
  });

  return {
    ADMIN_URL,
    APP_URL,
    VALKEY_URL,
    ISSUER,
    AUDIENCE,
    KID,
    KEY,
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
    get api() {
      return api;
    },
    set api(value: typeof api) {
      api = value;
    },
    get privateKey() {
      return privateKey;
    },
    set privateKey(value: typeof privateKey) {
      privateKey = value;
    },
    get orgA() {
      return orgA;
    },
    set orgA(value: typeof orgA) {
      orgA = value;
    },
    get tenantA() {
      return tenantA;
    },
    set tenantA(value: typeof tenantA) {
      tenantA = value;
    },
    get orgB() {
      return orgB;
    },
    set orgB(value: typeof orgB) {
      orgB = value;
    },
    get tenantB() {
      return tenantB;
    },
    set tenantB(value: typeof tenantB) {
      tenantB = value;
    },
    get kubernetesGenerationA() {
      return kubernetesGenerationA;
    },
    set kubernetesGenerationA(value: typeof kubernetesGenerationA) {
      kubernetesGenerationA = value;
    },
    get kubernetesGenerationB() {
      return kubernetesGenerationB;
    },
    set kubernetesGenerationB(value: typeof kubernetesGenerationB) {
      kubernetesGenerationB = value;
    },
    get argoGenerationA() {
      return argoGenerationA;
    },
    set argoGenerationA(value: typeof argoGenerationA) {
      argoGenerationA = value;
    },
    get argoGenerationB() {
      return argoGenerationB;
    },
    set argoGenerationB(value: typeof argoGenerationB) {
      argoGenerationB = value;
    },
    sign,
    auth,
    k8sSnap,
    argoSnap,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
