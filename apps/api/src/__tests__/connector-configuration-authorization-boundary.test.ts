import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { ConnectorRegistry, makePrometheusConnector } from '@sre/connectors';
import {
  connectorConfigs,
  impersonationSessions,
  memberships,
  platformOperators,
  tenantSecrets,
  users,
  withTenant,
  type MembershipRole,
} from '@sre/db';
import { createFixture } from './connectors.fixture';
import { registerTestConnector } from './connector-registry';

// Connector configuration carries the tenant's credentials for its own infrastructure. Reading it
// is ordinary member work; changing it is not. Every case here checks the durable effect as well as
// the status code, because a refusal that still wrote a row or a secret is not a refusal.

const fixture = createFixture();

const PROMETHEUS_SETTINGS = {
  baseUrl: 'https://prometheus.example.com',
  authType: 'bearer',
  eventTransport: 'none',
} as const;

const PROMETHEUS_CREDENTIAL = JSON.stringify({ type: 'bearer', token: 'prom-token' });

function prometheusRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  const providerFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url,
    );
    if (url.hostname === 'prometheus.example.com') {
      return Response.json({ status: 'success', data: { result: [] } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  registerTestConnector(registry, 'prometheus', (config) =>
    makePrometheusConnector(config, providerFetch, async () => ['93.184.216.34']),
  );
  return registry;
}

function connectorApp() {
  return fixture.makeConnApp(fetch, undefined, fixture.secrets, { registry: prometheusRegistry() });
}

async function setRole(role: MembershipRole): Promise<void> {
  await fixture.admin.db
    .update(memberships)
    .set({ role })
    .where(eq(memberships.tenantId, fixture.tenantA));
}

async function headers(): Promise<Record<string, string>> {
  return fixture.bearer(await fixture.sign(fixture.orgA));
}

async function actorUserId(): Promise<string> {
  const [actor] = await fixture.admin.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.issuer, fixture.ISSUER), eq(users.subject, fixture.orgA)));
  expect(actor).toBeDefined();
  return actor!.id;
}

/** Mints the support session `x-impersonation-session` resolves against: the platform-operator
 *  grant the header requires, plus a live, unexpired session over this workspace. */
async function startImpersonation(): Promise<string> {
  const actor = await actorUserId();
  await fixture.admin.db.insert(platformOperators).values({ userId: actor }).onConflictDoNothing();
  const [session] = await fixture.admin.db
    .insert(impersonationSessions)
    .values({
      actorUserId: actor,
      tenantId: fixture.tenantA,
      reason: 'Diagnose a customer-visible data source failure',
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: impersonationSessions.id });
  expect(session).toBeDefined();
  return session!.id;
}

function savePrometheus(app: ReturnType<typeof connectorApp>, auth: Record<string, string>) {
  return app.request('/connectors/prometheus', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: `Boundary Prometheus ${randomUUID().slice(0, 8)}`,
      settings: PROMETHEUS_SETTINGS,
      credential: PROMETHEUS_CREDENTIAL,
    }),
  });
}

/** Creates one verifiable data source as an administrator, then drops back to member. */
async function seedDataSource(
  app: ReturnType<typeof connectorApp>,
): Promise<{ id: string; enabled: boolean }> {
  await setRole('admin');
  const save = await savePrometheus(app, await headers());
  expect(save.status).toBe(200);
  const { connectorId } = (await save.json()) as { connectorId: string };
  await setRole('member');
  const [row] = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx
      .select({ id: connectorConfigs.id, enabled: connectorConfigs.enabled })
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, connectorId)),
  );
  expect(row).toBeDefined();
  return row!;
}

function dataSourceRows() {
  return withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx
      .select({
        id: connectorConfigs.id,
        enabled: connectorConfigs.enabled,
        deletedAt: connectorConfigs.deletedAt,
      })
      .from(connectorConfigs),
  );
}

function tenantSecretNames() {
  return withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx.select({ name: tenantSecrets.name }).from(tenantSecrets),
  );
}

afterEach(async () => {
  // The fixture's teardown deletes the identity these rows reference, so they cannot outlive a test.
  const actor = await actorUserId();
  await fixture.admin.db
    .delete(impersonationSessions)
    .where(eq(impersonationSessions.actorUserId, actor));
  await fixture.admin.db.delete(platformOperators).where(eq(platformOperators.userId, actor));
  await fixture.admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, fixture.tenantA));
  await fixture.admin.db
    .delete(connectorConfigs)
    .where(eq(connectorConfigs.tenantId, fixture.tenantA));
  await setRole('member');
});

describe('connector configuration authorization boundary', () => {
  test('a member connecting a data source stores neither the row nor its credential', async () => {
    await setRole('member');
    const response = await savePrometheus(connectorApp(), await headers());

    expect(response.status).toBe(403);
    expect(await dataSourceRows()).toEqual([]);
    expect(await tenantSecretNames()).toEqual([]);
  });

  test('a member disconnecting a data source leaves it connected', async () => {
    const app = connectorApp();
    const seeded = await seedDataSource(app);

    const response = await app.request(`/connectors/prometheus/${seeded.id}`, {
      method: 'DELETE',
      headers: await headers(),
    });

    expect(response.status).toBe(403);
    const rows = await dataSourceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  test('a member retesting a data source cannot flip its enabled state', async () => {
    const app = connectorApp();
    const seeded = await seedDataSource(app);
    // A save leaves the source disabled until a verification enables it, so the retest route is the
    // only thing that could change this column: an unchanged value proves the write never ran.
    expect(seeded.enabled).toBe(false);

    const response = await app.request(`/connectors/prometheus/${seeded.id}/test`, {
      method: 'POST',
      headers: await headers(),
    });

    expect(response.status).toBe(403);
    const rows = await dataSourceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(false);
  });

  test.each(['preview', 'bind', 'reconcile'])(
    'a member cannot %s provider lifecycle configuration',
    async (mode) => {
      await setRole('member');
      const response = await connectorApp().request(
        `/connectors/statuscake/${randomUUID()}/lifecycle`,
        {
          method: 'POST',
          headers: await headers(),
          body: JSON.stringify({ mode }),
        },
      );
      expect(response.status).toBe(403);
      expect(await dataSourceRows()).toEqual([]);
    },
  );

  test('a member still reads the workspace data sources', async () => {
    const app = connectorApp();
    const seeded = await seedDataSource(app);

    const response = await app.request('/connectors', { headers: await headers() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { connectors: Array<{ id: string; type: string }> };
    expect(body.connectors.map((connector) => connector.id)).toEqual([seeded.id]);
    expect(body.connectors.map((connector) => connector.type)).toEqual(['prometheus']);
  });

  test('an administrator connecting a data source persists it', async () => {
    await setRole('admin');
    const response = await savePrometheus(connectorApp(), await headers());

    expect(response.status).toBe(200);
    const { connectorId } = (await response.json()) as { connectorId: string };
    const rows = await dataSourceRows();
    expect(rows.map((row) => row.id)).toEqual([connectorId]);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  test('an impersonated support session connects nothing even as a workspace administrator', async () => {
    // The membership behind the session is an administrator, so the role clause alone would let
    // this through: only the impersonation clause can refuse it.
    await setRole('admin');
    const app = connectorApp();
    const impersonated = {
      ...(await headers()),
      'x-impersonation-session': await startImpersonation(),
    };

    // The session has to resolve for the refusal to mean anything. A read served under the same
    // header proves the identity layer accepted it and established the impersonated tenant.
    expect((await app.request('/connectors', { headers: impersonated })).status).toBe(200);

    const response = await savePrometheus(app, impersonated);

    expect(response.status).toBe(403);
    // An unresolved session answers its own message before this gate runs, so the wording is what
    // separates a gate refusal from a rejected header.
    expect(await response.json()).toEqual({
      error: 'A workspace owner or administrator must change this configuration.',
    });
    expect(await dataSourceRows()).toEqual([]);
    expect(await tenantSecretNames()).toEqual([]);
  });

  test('a member is refused webhook management before the data source id or body is read', async () => {
    await setRole('member');
    const response = await connectorApp().request(
      '/connectors/gitlab/not-a-data-source-id/management/preview',
      {
        method: 'POST',
        headers: await headers(),
        body: '{ this is not json',
      },
    );

    // A malformed id answers 400 and an unparseable body answers 400, so a 403 here can only come
    // from a check that runs before either of them.
    expect(response.status).toBe(403);
  });
});
