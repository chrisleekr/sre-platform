import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { Redis } from 'ioredis';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import {
  connectorConfigs,
  createIncident,
  makeDb,
  tenants,
  syncGitHubRepositories,
  syncGitLabProjects,
  type DbHandle,
} from '@sre/db';
import { seedMembership } from '@sre/db/test-support';
import { ConversationHub } from '@sre/hub';
import {
  makeGitHubConnector,
  makeGitLabConnector,
  type ConnectorConfig,
  type IDataSourceConnector,
} from '@sre/connectors';
import { CRED } from '../../../../packages/connectors/src/data-sources/github/__tests__/test-helpers';
import { incidentRoutes } from '../incidents';
import { makeTestAuth } from './auth-test-support';

export function issueFixture() {
  const tenantId = randomUUID(),
    otherTenantId = randomUUID(),
    connectorId = randomUUID();
  const issuer = `https://issues-${tenantId}.example/`;
  let admin: DbHandle, app: DbHandle, redis: Redis, hub: ConversationHub;
  let api: Hono,
    actor = '',
    peer = '',
    token = '',
    peerToken = '',
    otherToken = '';
  let source: IDataSourceConnector;
  let provider: 'github' | 'gitlab' = 'github';
  let failure: number | 'network' | 'invalid-json' | 'invalid-shape' | 'partial' | null = null;
  let version = 1;
  let issue = {
    title: 'Initial issue',
    body: 'Observed evidence',
    state: 'open',
    labels: ['ops'],
    assignees: [] as string[],
    updatedAt: '2026-09-13T00:00:00Z',
  };
  const writes: { method: string; body: Record<string, unknown>; token: string | null }[] = [];
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (!['api.github.com', 'gitlab.example.com'].includes(url.hostname))
        throw new Error('Unscoped provider request');
      if (url.pathname.endsWith('/access_tokens'))
        return Response.json(
          { token: 'scoped-issue-token', expires_at: new Date(Date.now() + 60_000).toISOString() },
          { status: 201 },
        );
      const method = init.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/api/v4/projects/71')
        return Response.json({ id: 71, path_with_namespace: 'team/service', archived: false });
      if (method !== 'GET') {
        if (!['POST', 'PUT', 'PATCH'].includes(method) || !url.pathname.includes('/issues'))
          throw new Error('Unapproved provider operation');
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push({ method, body, token: new Headers(init.headers).get('PRIVATE-TOKEN') });
        if (failure === 'network') throw new Error('Simulated response lost');
        if (typeof failure === 'number')
          return Response.json({ message: 'sensitive upstream detail' }, { status: failure });
        issue = {
          ...issue,
          title: String(body.title ?? issue.title),
          body: String(body.description ?? body.body ?? issue.body),
          state:
            body.state_event === 'close'
              ? 'closed'
              : body.state_event === 'reopen'
                ? 'open'
                : String(body.state ?? issue.state),
          labels:
            body.labels === undefined
              ? issue.labels
              : Array.isArray(body.labels)
                ? (body.labels as string[])
                : String(body.labels).split(',').filter(Boolean),
          assignees:
            body.assignee_ids !== undefined
              ? (body.assignee_ids as number[]).map(String)
              : ((body.assignees as string[]) ?? issue.assignees),
          updatedAt: new Date(Date.now() + writes.length).toISOString(),
        };
      }
      if (method !== 'GET' && failure === 'invalid-json') return new Response('not json');
      if (method !== 'GET' && failure === 'invalid-shape') return Response.json({ id: 12 });
      if (method !== 'GET' && failure === 'partial') issue = { ...issue, labels: [] };
      const value =
        provider === 'github'
          ? {
              number: 12,
              ...issue,
              assignees: issue.assignees.map((login) => ({ login })),
              updated_at: issue.updatedAt,
            }
          : {
              iid: 12,
              title: issue.title,
              description: issue.body,
              state: issue.state === 'open' ? 'opened' : 'closed',
              labels: issue.labels,
              assignees: issue.assignees.map((id) => ({ id: Number(id) })),
              updated_at: issue.updatedAt,
            };
      return Response.json(method === 'GET' && url.pathname.endsWith('/issues') ? [value] : value);
    },
    { preconnect() {} },
  );
  function configure(kind: 'github' | 'gitlab', enabled = true) {
    if (provider !== kind) issue = { ...issue, assignees: [] };
    provider = kind;
    const repository = {
      repositoryId: '71',
      fullName: 'team/service',
      defaultBranch: 'main',
      private: true,
      archived: false,
      htmlUrl: 'https://github.com/team/service',
    };
    const config: ConnectorConfig = {
      id: connectorId,
      tenantId,
      name: kind,
      type: kind,
      settings: {
        baseUrl: 'https://gitlab.example.com',
        groupId: 7,
        groupPath: 'team',
        issueManagement: { enabled, repositories: ['team/service'] },
      },
      getCredential: async () => (kind === 'github' ? CRED : 'read-token'),
      getIssueCredential: async () => 'write-token',
      repositories: {
        search: async () => [repository],
        resolve: async () => [repository],
        recentEvents: async () => [],
      },
    };
    source =
      kind === 'github'
        ? makeGitHubConnector(config, transport, async () => ['93.184.216.34'])
        : makeGitLabConnector(config, transport, async () => ['93.184.216.34']);
    source = { ...source, generation: { id: connectorId, lifecycleVersion: version } };
  }
  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL || !process.env.VALKEY_URL)
      throw new Error('Isolated test services required');
    admin = makeDb(process.env.DATABASE_URL);
    app = makeDb(process.env.APP_DATABASE_URL);
    redis = new Redis(process.env.VALKEY_URL);
    hub = new ConversationHub(app.db, redis);
    await admin.db.insert(tenants).values([
      { id: tenantId, name: 'Issue tests' },
      { id: otherTenantId, name: 'Other workspace' },
    ]);
    actor = await seedMembership(admin.db, { issuer, subject: 'actor' }, tenantId);
    peer = await seedMembership(admin.db, { issuer, subject: 'peer' }, tenantId);
    await seedMembership(admin.db, { issuer, subject: 'other' }, otherTenantId);
    await admin.db.insert(connectorConfigs).values({
      id: connectorId,
      tenantId,
      type: 'github',
      name: 'Issues',
      enabled: true,
      settings: {},
      lifecycleVersion: version,
    });
    await syncGitHubRepositories(app.db, tenantId, connectorId, '4242', [
      {
        installationId: '4242',
        repositoryId: '71',
        owner: 'team',
        name: 'service',
        fullName: 'team/service',
        private: true,
        archived: false,
        htmlUrl: 'https://github.com/team/service',
      },
    ]);
    await syncGitLabProjects(app.db, tenantId, connectorId, '7', [
      {
        groupId: '7',
        projectId: '71',
        name: 'service',
        fullPath: 'team/service',
        archived: false,
        webUrl: 'https://gitlab.example.com/team/service',
      },
    ]);
    const keys = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = 'issues';
    const auth = await makeTestAuth({
      adminDb: admin.db,
      appDb: app.db,
      issuer,
      audience: 'sre-api',
      keys: createLocalJWKSet({ keys: [jwk] }),
      bindings: [
        { tenantId, subject: 'actor' },
        { tenantId, subject: 'peer' },
        { tenantId: otherTenantId, subject: 'other' },
      ],
    });
    const sign = (sub: string) =>
      new SignJWT({ sub })
        .setProtectedHeader({ alg: 'RS256', kid: 'issues' })
        .setIssuer(issuer)
        .setAudience('sre-api')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey);
    [token, peerToken, otherToken] = await Promise.all([
      sign('actor'),
      sign('peer'),
      sign('other'),
    ]);
    configure('github');
    api = new Hono().route(
      '/incidents',
      incidentRoutes({
        auth,
        db: app.db,
        hub,
        cache: { get: async () => [], set: async () => undefined },
        resolveConnectors: async (tenant) => (tenant === tenantId ? [source] : []),
      }),
    );
  });
  afterAll(async () => {
    if (admin) {
      await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
      await admin.db.delete(tenants).where(eq(tenants.id, otherTenantId));
    }
    await redis?.quit();
    await app?.sql.end();
    await admin?.sql.end();
  });
  return {
    transport,
    tenantId,
    otherTenantId,
    connectorId,
    writes,
    get admin() {
      return admin;
    },
    get app() {
      return app;
    },
    get api() {
      return api;
    },
    get actor() {
      return actor;
    },
    get peer() {
      return peer;
    },
    get hub() {
      return hub;
    },
    get token() {
      return token;
    },
    get deps() {
      return {
        db: app.db,
        hub,
        resolveConnectors: async (tenant: string) => (tenant === tenantId ? [source] : []),
      };
    },
    configure,
    fail(value: typeof failure) {
      failure = value;
    },
    changeIssue() {
      issue = { ...issue, title: 'Changed elsewhere', updatedAt: new Date().toISOString() };
    },
    async changeVersion() {
      version++;
      await admin.db
        .update(connectorConfigs)
        .set({ lifecycleVersion: version })
        .where(eq(connectorConfigs.id, connectorId));
      configure(provider);
    },
    async incident() {
      return (
        await createIncident(app.db, tenantId, {
          fingerprint: randomUUID(),
          alertSource: 'datadog',
          service: 'service',
          severity: 'sev3',
        })
      ).id;
    },
    request(id: string, path: string, body?: unknown, as: 'actor' | 'peer' | 'other' = 'actor') {
      return api.request(`/incidents/${id}/issues/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${as === 'peer' ? peerToken : as === 'other' ? otherToken : token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}
