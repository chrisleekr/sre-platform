import { seedMembership } from '@sre/db/test-support';
// Tenant-isolation gate (mirrors incidents.test.ts auth + db-audit-sink.test.ts cross-tenant style),
// live PG (auth org_id -> tenant resolution) + Valkey (the snapshot cache). Proves GET /infrastructure
// and GET /deployments return ONLY the calling tenant's cached snapshots, keyed by the JWT-resolved
// tenant id, never another tenant's — and that the {infrastructure}/{deployments} wrapper the
// dashboard hooks read is shaped correctly.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import {
  connectorConfigs,
  deployments,
  memberships,
  tenantIdentityBindings,
  tenants,
  upsertDeployments,
  users,
} from '@sre/db';

import { makeSnapshotCache } from '@sre/queue';

import { createFixture } from './snapshots.fixture';
import { bindTestIdentity } from './auth-test-support';

const __fixture = createFixture();

describe('GET /infrastructure', () => {
  test('returns only the calling tenant’s infra snapshots (isolation), in the {infrastructure} wrapper', async () => {
    const res = await __fixture.api.request(
      '/infrastructure',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      infrastructure: Array<Record<string, unknown>>;
    };
    expect(body.infrastructure).toHaveLength(1);
    expect(body.infrastructure[0]!.entityId).toBe('pod-a'); // tenantA only, never pod-b
    expect(body.infrastructure[0]!.source).toBe('kubernetes');
    // observedAt is serialized to an ISO string for the client.
    expect(body.infrastructure[0]!.observedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(body.infrastructure[0]).toMatchObject({
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
          lastTerminatedAt: '2026-06-30T23:55:00.000Z',
        },
      ],
    });
    expect(body.infrastructure[0]).not.toHaveProperty('serviceAccountToken');
  });

  test('another tenant sees only its own snapshots', async () => {
    const res = await __fixture.api.request(
      '/infrastructure',
      __fixture.auth(await __fixture.sign(__fixture.orgB)),
    );
    const body = (await res.json()) as { infrastructure: Array<{ entityId: string }> };
    expect(body.infrastructure).toHaveLength(1);
    expect(body.infrastructure[0]!.entityId).toBe('pod-b');
  });

  test('requires authentication', async () => {
    expect((await __fixture.api.request('/infrastructure')).status).toBe(401);
  });
});

describe('GET /deployments', () => {
  test('reshapes gitlab snapshots into the client Deployment, isolated per tenant', async () => {
    const res = await __fixture.api.request(
      '/deployments',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<{
        source: string;
        repo: string;
        ref: string;
        sha: string;
        status: string;
        deployedAt: string;
        url?: string;
      }>;
    };
    expect(body.deployments).toHaveLength(2);
    const gitlab = body.deployments.find((deployment) => deployment.source === 'gitlab');
    expect(gitlab).toMatchObject({
      source: 'gitlab',
      repo: '71',
      ref: 'main',
      sha: 'deadbeef',
      status: 'failed',
      url: 'https://gl/p/42',
    });
    expect(gitlab!.deployedAt).toBe('2026-07-01T00:05:00.000Z');
    expect(body.deployments.find((deployment) => deployment.source === 'argocd')).toMatchObject({
      providerId: 'uid-checkout:7',
      revisions: ['release-app', 'release-config'],
      operationPhase: 'Succeeded',
    });
  });

  test('another tenant sees only its own deployments', async () => {
    const res = await __fixture.api.request(
      '/deployments',
      __fixture.auth(await __fixture.sign(__fixture.orgB)),
    );
    const body = (await res.json()) as { deployments: Array<{ url?: string }> };
    expect(body.deployments).toHaveLength(1);
    expect(body.deployments[0]!.url).toBe('https://gl/p/99');
  });
});

describe('GET /gitops', () => {
  test('projects only the calling tenant live Application state without raw metadata', async () => {
    const response = await __fixture.api.request(
      '/gitops',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      applications: [
        {
          source: 'argocd',
          applicationName: 'checkout',
          syncStatus: 'OutOfSync',
          healthStatus: 'Degraded',
          operationPhase: 'Running',
          revisions: ['app-revision', 'config-revision'],
          destinationNamespace: 'payments',
          conditions: [{ type: 'ComparisonError', message: 'render failed' }],
        },
      ],
    });
    expect(text).not.toContain('orders');
    expect(text).not.toContain('must-not-leave-the-api');
    expect(text).not.toContain(__fixture.tenantA);
  });

  test('requires authentication', async () => {
    expect((await __fixture.api.request('/gitops')).status).toBe(401);
  });

  test('does not serve cached ArgoCD state while the connector is disabled or absent', async () => {
    await __fixture.admin.db
      .update(connectorConfigs)
      .set({ enabled: false })
      .where(
        and(eq(connectorConfigs.tenantId, __fixture.tenantA), eq(connectorConfigs.type, 'argocd')),
      );
    const disabled = await __fixture.api.request(
      '/gitops',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    expect(await disabled.json()).toEqual({ applications: [] });

    await __fixture.admin.db
      .delete(connectorConfigs)
      .where(
        and(eq(connectorConfigs.tenantId, __fixture.tenantA), eq(connectorConfigs.type, 'argocd')),
      );
    const absent = await __fixture.api.request(
      '/gitops',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    expect(await absent.json()).toEqual({ applications: [] });

    const [replacement] = await __fixture.admin.db
      .insert(connectorConfigs)
      .values({
        tenantId: __fixture.tenantA,
        type: 'argocd',
        settings: {},
        enabled: true,
        verificationSucceededAt: new Date('2026-08-22T00:00:00Z'),
        pollSucceededAt: new Date('2026-08-22T00:30:00Z'),
      })
      .returning({ id: connectorConfigs.id, lifecycleVersion: connectorConfigs.lifecycleVersion });
    __fixture.argoGenerationA = replacement!;
    await makeSnapshotCache(__fixture.redis).set(
      __fixture.tenantA,
      'argocd',
      [__fixture.argoSnap(__fixture.tenantA, 'checkout')],
      60,
      __fixture.argoGenerationA,
    );
  });

  test('does not serve a pre-verification cache until a later successful poll is recorded', async () => {
    await __fixture.admin.db
      .update(connectorConfigs)
      .set({
        enabled: true,
        verificationSucceededAt: new Date('2026-08-22T02:00:00Z'),
        pollSucceededAt: new Date('2026-08-22T00:30:00Z'),
      })
      .where(
        and(eq(connectorConfigs.tenantId, __fixture.tenantA), eq(connectorConfigs.type, 'argocd')),
      );
    const stale = await __fixture.api.request(
      '/gitops',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    expect(await stale.json()).toEqual({ applications: [] });

    await __fixture.admin.db
      .update(connectorConfigs)
      .set({ pollSucceededAt: new Date('2026-08-22T02:01:00Z') })
      .where(
        and(eq(connectorConfigs.tenantId, __fixture.tenantA), eq(connectorConfigs.type, 'argocd')),
      );
    const fresh = await __fixture.api.request(
      '/gitops',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    expect((await fresh.json()) as { applications: unknown[] }).toMatchObject({
      applications: [{ applicationName: 'checkout' }],
    });
  });
});

// C1 / C2 / C6 — GET /deployments serves the durable `deployments` table, NOT the Valkey
// snapshot cache, so the panel survives snapshot TTL expiry. Self-contained tenant with rows ONLY in
// Postgres and NO gitlab cache entry: the route reads Postgres (under RLS) and returns the persisted
// rows incl. the `url` column, with a non-empty status from the DeployStatus union.
describe('GET /deployments served from Postgres', () => {
  const VALID_STATUS = new Set(['success', 'failed', 'running', 'pending', 'canceled']);
  let orgC: string;
  let tenantC: string;
  const shaC = `pg-${randomUUID()}`;
  const serviceC = `checkout-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    orgC = `org_${randomUUID().slice(0, 8)}`;
    tenantC = randomUUID();
    await __fixture.admin.db.insert(tenants).values({ id: tenantC, name: 'C' });
    await seedMembership(__fixture.admin.db, { issuer: __fixture.ISSUER, subject: orgC }, tenantC);
    await bindTestIdentity({
      adminDb: __fixture.admin.db,
      issuer: __fixture.ISSUER,
      tenantId: tenantC,
      subject: orgC,
    });
    // Persist a deploy to Postgres ONLY. No cache.set for tenantC:gitlab — proves the read is durable.
    await upsertDeployments(__fixture.app.db, tenantC, [
      {
        source: 'gitlab',
        repo: '71',
        ref: 'main',
        sha: shaC,
        service: serviceC,
        status: 'success',
        deployedAt: new Date('2026-07-01T00:00:00Z'),
        url: 'https://gl/p/pg',
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    await __fixture.admin.db.delete(deployments).where(sql`tenant_id = ${tenantC}`);
    await __fixture.admin.db.delete(memberships).where(sql`tenant_id = ${tenantC}`);
    await __fixture.admin.db.delete(tenantIdentityBindings).where(sql`tenant_id = ${tenantC}`);
    await __fixture.admin.db
      .delete(users)
      .where(sql`issuer = ${__fixture.ISSUER} and subject = ${orgC}`);
    await __fixture.admin.db.delete(tenants).where(sql`id = ${tenantC}`);
  });

  test('C1: returns the Postgres-persisted deploy with no gitlab snapshot cache present', async () => {
    const res = await __fixture.api.request(
      '/deployments',
      __fixture.auth(await __fixture.sign(orgC)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<{ sha: string; repo: string; status: string; url?: string }>;
    };
    const row = body.deployments.find((d) => d.sha === shaC);
    expect(row).toBeDefined(); // served from Postgres though no snapshot cache was seeded
    expect(row!.repo).toBe('71');
  });

  test('C2: the persisted url column is returned', async () => {
    const res = await __fixture.api.request(
      '/deployments',
      __fixture.auth(await __fixture.sign(orgC)),
    );
    const body = (await res.json()) as { deployments: Array<{ sha: string; url?: string }> };
    const row = body.deployments.find((d) => d.sha === shaC);
    expect(row?.url).toBe('https://gl/p/pg');
  });

  test('C6: every served status is in the DeployStatus union and never empty', async () => {
    const res = await __fixture.api.request(
      '/deployments',
      __fixture.auth(await __fixture.sign(orgC)),
    );
    const body = (await res.json()) as { deployments: Array<{ status: string }> };
    expect(body.deployments.length).toBeGreaterThan(0);
    for (const d of body.deployments) {
      expect(d.status).not.toBe('');
      expect(VALID_STATUS.has(d.status)).toBe(true);
    }
  });
});

// [RED] — GET /deployments coerces stored free-text status onto the DeployStatus union at
// the read boundary, and keyset-paginates older history via an opaque cursor. Self-contained
// tenant so the page contents and count are deterministic. RED today: the route passes status through raw,
// ignores query params, and returns no nextCursor.
describe('GET /deployments status coercion + pagination', () => {
  const VALID_STATUS = new Set(['success', 'failed', 'running', 'pending', 'canceled']);
  let orgD: string;
  let tenantD: string;
  // Newest → oldest. `sha2` carries a NON-union stored status the route must coerce.
  const sha1 = `d1-${randomUUID()}`;
  const sha2 = `d2-${randomUUID()}`;
  const sha3 = `d3-${randomUUID()}`;

  beforeAll(async () => {
    orgD = `org_${randomUUID().slice(0, 8)}`;
    tenantD = randomUUID();
    await __fixture.admin.db.insert(tenants).values({ id: tenantD, name: 'D' });
    await seedMembership(__fixture.admin.db, { issuer: __fixture.ISSUER, subject: orgD }, tenantD);
    await bindTestIdentity({
      adminDb: __fixture.admin.db,
      issuer: __fixture.ISSUER,
      tenantId: tenantD,
      subject: orgD,
    });
    await upsertDeployments(__fixture.app.db, tenantD, [
      {
        source: 'gitlab',
        repo: '71',
        ref: 'main',
        sha: sha1,
        service: 'checkout',
        environment: 'production',
        actor: 'release-bot',
        status: 'success',
        deployedAt: new Date('2026-07-03T00:00:00Z'),
      },
      {
        source: 'gitlab',
        repo: '71',
        ref: 'main',
        sha: sha2,
        service: null,
        // Stored free-text status outside the client union — must be coerced before it reaches the panel.
        status: 'skipped',
        deployedAt: new Date('2026-07-02T00:00:00Z'),
      },
      {
        source: 'gitlab',
        repo: '71',
        ref: 'main',
        sha: sha3,
        service: 'checkout',
        status: 'running',
        deployedAt: new Date('2026-07-01T00:00:00Z'),
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    await __fixture.admin.db.delete(deployments).where(sql`tenant_id = ${tenantD}`);
    await __fixture.admin.db.delete(memberships).where(sql`tenant_id = ${tenantD}`);
    await __fixture.admin.db.delete(tenantIdentityBindings).where(sql`tenant_id = ${tenantD}`);
    await __fixture.admin.db
      .delete(users)
      .where(sql`issuer = ${__fixture.ISSUER} and subject = ${orgD}`);
    await __fixture.admin.db.delete(tenants).where(sql`id = ${tenantD}`);
  });

  test('coerces a non-union stored status into the DeployStatus union', async () => {
    const res = await __fixture.api.request(
      '/deployments',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployments: Array<{ sha: string; status: string }> };
    const coerced = body.deployments.find((d) => d.sha === sha2);
    expect(coerced).toBeDefined();
    // 'skipped' is not a union member; the served value must be, and never empty.
    expect(coerced!.status).not.toBe('skipped');
    for (const d of body.deployments) {
      expect(d.status).not.toBe('');
      expect(VALID_STATUS.has(d.status)).toBe(true);
    }
  });

  test('a malformed cursor is a 400, never a silent page one', async () => {
    const res = await __fixture.api.request(
      '/deployments?cursor=not-a-valid-cursor',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(400);
  });

  test('a valid cursor pages to the older deploys with a nextCursor', async () => {
    const first = await __fixture.api.request(
      '/deployments?limit=2',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      deployments: Array<{ sha: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.deployments.map((d) => d.sha)).toEqual([sha1, sha2]); // two newest
    expect(typeof firstBody.nextCursor).toBe('string');

    const older = await __fixture.api.request(
      `/deployments?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(older.status).toBe(200);
    const olderBody = (await older.json()) as {
      deployments: Array<{ sha: string }>;
      nextCursor: string | null;
    };
    expect(olderBody.deployments.some((d) => d.sha === sha3)).toBe(true); // the older page
    expect(olderBody.deployments.some((d) => d.sha === sha1)).toBe(false); // page one is not repeated
    expect(olderBody.nextCursor).toBeNull();
  });

  test('returns service-aware filtered evidence and an all-matches summary', async () => {
    const res = await __fixture.api.request(
      '/deployments?limit=1&service=checkout&source=gitlab&from=2026-07-01T00%3A00%3A00Z',
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<{ sha: string; service?: string; environment?: string; actor?: string }>;
      nextCursor: string | null;
      summary: {
        total: number;
        failed: number;
        active: number;
        environmentMissing: number;
        latestAt: string | null;
      };
    };
    expect(body.deployments).toEqual([
      expect.objectContaining({
        sha: sha1,
        service: 'checkout',
        environment: 'production',
        actor: 'release-bot',
      }),
    ]);
    expect(body.nextCursor).not.toBeNull();
    expect(body.summary).toMatchObject({ total: 2, failed: 0, active: 1, environmentMissing: 1 });
    expect(body.summary.latestAt).toBe('2026-07-03T00:00:00.000Z');
  });

  test('rejects invalid deployment filters', async () => {
    for (const query of ['status=unknown', 'from=not-a-date', 'source=gitlab%2Fadmin']) {
      const res = await __fixture.api.request(
        `/deployments?limit=20&${query}`,
        __fixture.auth(await __fixture.sign(orgD)),
      );
      expect(res.status).toBe(400);
    }
  });

  // a syntactically valid base64url JSON cursor whose `id` is not a UUID must 400, not reach
  // Postgres and 22P02 (500). Guards the UUID_RE check in decodeCursor.
  test('a well-formed cursor carrying a non-UUID id is a 400, not a 500', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ deployedAt: '2026-07-01T00:00:00Z', id: 'not-a-uuid' }),
    ).toString('base64url');
    const res = await __fixture.api.request(
      `/deployments?cursor=${encodeURIComponent(cursor)}`,
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(400);
  });

  // a valid base64url JSON cursor whose `deployedAt` is unparseable must 400 (guards the
  // Number.isNaN date check in decodeCursor).
  test('a well-formed cursor with an unparseable deployedAt is a 400', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ deployedAt: 'not-a-date', id: randomUUID() }),
    ).toString('base64url');
    const res = await __fixture.api.request(
      `/deployments?cursor=${encodeURIComponent(cursor)}`,
      __fixture.auth(await __fixture.sign(orgD)),
    );
    expect(res.status).toBe(400);
  });

  // parseLimit boundaries: a non-positive or non-numeric?limit falls back to the repo default
  // (it must NOT clamp to zero rows). tenantD has 3 rows, well under the default page size, so a fallback
  // returns all three with no further page.
  test('?limit=0 and?limit=abc fall back to the default page size, not zero rows', async () => {
    for (const bad of ['0', 'abc']) {
      const res = await __fixture.api.request(
        `/deployments?limit=${bad}`,
        __fixture.auth(await __fixture.sign(orgD)),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deployments: Array<{ sha: string }>;
        nextCursor: string | null;
      };
      expect(body.deployments).toHaveLength(3);
      expect(body.nextCursor).toBeNull();
    }
  });
});

// parseLimit clamps an oversized?limit to 100 so one request cannot scan the whole history.
// Needs > 100 rows to observe the cap, so a dedicated tenant seeds 101; ?limit=99999 must return exactly
// 100 rows and a non-null nextCursor (the 101st is on the next page).
describe('GET /deployments limit clamp', () => {
  let orgE: string;
  let tenantE: string;

  beforeAll(async () => {
    orgE = `org_${randomUUID().slice(0, 8)}`;
    tenantE = randomUUID();
    await __fixture.admin.db.insert(tenants).values({ id: tenantE, name: 'E' });
    await seedMembership(__fixture.admin.db, { issuer: __fixture.ISSUER, subject: orgE }, tenantE);
    await bindTestIdentity({
      adminDb: __fixture.admin.db,
      issuer: __fixture.ISSUER,
      tenantId: tenantE,
      subject: orgE,
    });
    const rows = Array.from({ length: 101 }, (_unused, i) => ({
      source: 'gitlab',
      repo: '71',
      ref: 'main',
      sha: `clamp-${i}-${randomUUID()}`,
      service: null,
      status: 'success',
      // Distinct, recent deployed_at per row (seconds apart) so ordering is deterministic.
      deployedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i)),
    }));
    await upsertDeployments(__fixture.app.db, tenantE, rows);
  }, 30_000);

  afterAll(async () => {
    await __fixture.admin.db.delete(deployments).where(sql`tenant_id = ${tenantE}`);
    await __fixture.admin.db.delete(memberships).where(sql`tenant_id = ${tenantE}`);
    await __fixture.admin.db.delete(tenantIdentityBindings).where(sql`tenant_id = ${tenantE}`);
    await __fixture.admin.db
      .delete(users)
      .where(sql`issuer = ${__fixture.ISSUER} and subject = ${orgE}`);
    await __fixture.admin.db.delete(tenants).where(sql`id = ${tenantE}`);
  });

  test('an oversized ?limit is clamped to 100 rows, with a further page remaining', async () => {
    const res = await __fixture.api.request(
      '/deployments?limit=99999',
      __fixture.auth(await __fixture.sign(orgE)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<{ sha: string }>;
      nextCursor: string | null;
    };
    expect(body.deployments).toHaveLength(100); // clamped from 99999
    expect(body.nextCursor).not.toBeNull(); // the 101st row is on the next page
  });
});
