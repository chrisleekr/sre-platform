import { seedMembership } from '@sre/db/test-support';
import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { connectorToolKey } from '@sre/agent-tools';
import { ConnectorRegistry, connectorCapabilities } from '@sre/connectors';
import {
  agentToolCalls,
  connectorConfigs,
  connectorCredentialKey,
  createIncident,
  incidents,
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  tenantSecrets,
  tenants,
  users,
  withTenant,
  type DbHandle,
} from '@sre/db';
import { eq, inArray } from 'drizzle-orm';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as z from 'zod';
import { makeApp } from '../app';
import { makeTestAuth } from './auth-test-support';
import { registerTestConnector } from './connector-registry';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const ISSUER = 'https://mcp.test.local/';
const AUDIENCE = 'sre-api';
const KID = 'mcp-key';
const SECRET_KEY = Buffer.alloc(32, 4).toString('base64');

let admin: DbHandle;
let appDb: DbHandle;
let api: ReturnType<typeof makeApp>;
let tenantId: string;
let foreignTenantId: string;
let subject: string;
let incidentId: string;
let foreignIncidentId: string;
let token: string;
let tokenWithoutMcpScope: string;
let tokenWithoutExp: string;
let connectorId: string;
let secondaryConnectorId: string;
let connectorConstructions = 0;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  appDb = makeDb(APP_URL);
  tenantId = randomUUID();
  foreignTenantId = randomUUID();
  subject = `mcp-${randomUUID()}`;
  await admin.db.insert(tenants).values([
    { id: tenantId, name: `mcp-${tenantId}` },
    { id: foreignTenantId, name: `mcp-${foreignTenantId}` },
  ]);
  await seedMembership(admin.db, { issuer: ISSUER, subject }, tenantId);
  incidentId = (
    await createIncident(admin.db, tenantId, {
      fingerprint: `mcp-${randomUUID()}`,
      alertSource: 'test',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  foreignIncidentId = (
    await createIncident(admin.db, foreignTenantId, {
      fingerprint: `mcp-foreign-${randomUUID()}`,
      alertSource: 'test',
      service: 'private-payments',
      severity: 'sev1',
    })
  ).id;

  const keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });
  token = await new SignJWT({ sub: subject, scope: 'mcp' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
  tokenWithoutMcpScope = await new SignJWT({ sub: subject })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
  // Carries the mcp scope but no `exp`, so only the missing time claim can decide the outcome.
  tokenWithoutExp = await new SignJWT({ sub: subject, scope: 'mcp' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .sign(keys.privateKey);

  const registry = new ConnectorRegistry();
  registerTestConnector(registry, 'statuscake', (config) => {
    connectorConstructions += 1;
    return {
      id: config.id,
      name: config.name,
      type: 'statuscake',
      capabilities: connectorCapabilities('statuscake'),
      snapshot: async () => [],
      fetchTriageContext: async () => ({ source: 'statuscake', data: {} }),
      tools: () => [
        {
          name: 'list_tests',
          description: 'List uptime tests for the incident service.',
          inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
          run: async ({ limit }) => {
            if (limit === 10) throw new Error('synthetic provider failure');
            return {
              dataSourceId: config.id,
              dataSourceName: config.name,
              service: 'checkout',
              limit,
              tests: ['checkout-web'],
            };
          },
        },
      ],
      probe: async () => ({
        status: 'healthy' as const,
        reachable: true,
        authorized: true,
        warnings: [],
      }),
    };
  });
  const secrets = makeSecretStore(appDb.db, SECRET_KEY);
  await withTenant(appDb.db, tenantId, async (tx) => {
    const [connector] = await tx
      .insert(connectorConfigs)
      .values({
        tenantId,
        name: 'Acceptance StatusCake',
        type: 'statuscake',
        settings: {},
        enabled: true,
      })
      .returning({ id: connectorConfigs.id });
    connectorId = connector!.id;
    const [secondary] = await tx
      .insert(connectorConfigs)
      .values({
        tenantId,
        name: 'Secondary StatusCake',
        type: 'statuscake',
        settings: {},
        enabled: true,
      })
      .returning({ id: connectorConfigs.id });
    secondaryConnectorId = secondary!.id;
    await secrets.put(tenantId, connectorCredentialKey(connectorId), 'test-token', tx);
    await secrets.put(
      tenantId,
      connectorCredentialKey(secondaryConnectorId),
      'secondary-test-token',
      tx,
    );
  });
  api = makeApp({
    auth: await makeTestAuth({
      adminDb: admin.db,
      appDb: appDb.db,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet),
      bindings: [{ tenantId, subject }],
    }),
    readinessDb: appDb.db,
    appDb: appDb.db,
    secrets,
    registry,
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(agentToolCalls).where(eq(agentToolCalls.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, tenantId));
    await admin.db
      .delete(incidents)
      .where(inArray(incidents.tenantId, [tenantId, foreignTenantId]));
    await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await admin.db
      .delete(tenantIdentityBindings)
      .where(eq(tenantIdentityBindings.tenantId, tenantId));
    await admin.db.delete(users).where(eq(users.subject, subject));
    await admin.db.delete(tenants).where(inArray(tenants.id, [tenantId, foreignTenantId]));
    await admin.close();
  }
  if (appDb) await appDb.close();
});

describe('incident-scoped MCP facade', () => {
  test('challenges unauthenticated clients and exposes protected-resource metadata', async () => {
    const response = await api.request(`/mcp/incidents/${incidentId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');

    const metadata = await api.request(
      `/.well-known/oauth-protected-resource/mcp/incidents/${incidentId}`,
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      authorization_servers: expect.arrayContaining([ISSUER]),
    });
  });

  test('requires the MCP scope before incident lookup or tool construction', async () => {
    const response = await api.request(`/mcp/incidents/${incidentId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenWithoutMcpScope}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('insufficient_scope');
    expect(response.headers.get('www-authenticate')).toContain('scope="mcp"');
  });

  // Pinning test. The gate refuses a token with no `exp` today via its own
  // `expiresAt === undefined` branch, and must still refuse it once resolveTenantFromToken rejects
  // such a token outright and that branch is removed. Green before and after, by design.
  test('refuses a token with no exp exactly as it refuses an invalid one', async () => {
    const response = await api.request(`/mcp/incidents/${incidentId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenWithoutExp}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  test('rejects oversized MCP requests before the SDK buffers or parses them', async () => {
    const response = await api.request(`/mcp/incidents/${incidentId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: 'x'.repeat(1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload too large' });
  });

  test('hides foreign, missing, and archived incidents before constructing tools or writing audit rows', async () => {
    const missingIncidentId = randomUUID();
    const archivedIncidentId = (
      await createIncident(admin.db, tenantId, {
        fingerprint: `mcp-archived-${randomUUID()}`,
        alertSource: 'test',
        service: 'deleted-checkout',
        severity: 'sev3',
      })
    ).id;
    await admin.db
      .update(incidents)
      .set({ status: 'closed', archivedAt: new Date() })
      .where(eq(incidents.id, archivedIncidentId));
    for (const requestedIncidentId of [foreignIncidentId, missingIncidentId, archivedIncidentId]) {
      const response = await api.request(`/mcp/incidents/${requestedIncidentId}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'incident not found' });
    }

    expect(connectorConstructions).toBe(0);
    const audit = await admin.db
      .select({ incidentId: agentToolCalls.incidentId })
      .from(agentToolCalls)
      .where(
        inArray(agentToolCalls.incidentId, [
          foreignIncidentId,
          missingIncidentId,
          archivedIncidentId,
        ]),
      );
    expect(audit).toEqual([]);
  });

  test('lists and runs multiple same-type tools through MCP with an incident audit', async () => {
    const endpoint = new URL(`http://sre.test/mcp/incidents/${incidentId}`);
    const fetchImpl: FetchLike = async (input, init) => {
      const request =
        input instanceof Request
          ? input
          : new Request(typeof input === 'string' ? input : input.toString(), init);
      return api.fetch(request);
    };
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: { token: async () => token },
      fetch: fetchImpl,
    });
    const client = new Client(
      { name: 'sre-platform-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    const listed = await client.listTools();
    const toolName = `statuscake_${connectorToolKey(connectorId)}_list_tests`;
    const secondaryToolName = `statuscake_${connectorToolKey(secondaryConnectorId)}_list_tests`;
    expect(listed.tools.map((tool) => tool.name)).toContain(toolName);
    expect(listed.tools.map((tool) => tool.name)).toContain(secondaryToolName);
    expect(listed.tools.map((tool) => tool.name)).toContain('investigate_code');
    expect(listed.tools.map((tool) => tool.name)).toContain('resolve_entity_context');
    expect(listed.tools.map((tool) => tool.name)).toContain('search_incident_evidence');
    expect(listed.tools.find((tool) => tool.name === toolName)?.description).toContain(
      'Acceptance StatusCake',
    );
    expect(listed.tools.find((tool) => tool.name === secondaryToolName)?.description).toContain(
      'Secondary StatusCake',
    );

    const codeResult = await client.callTool({
      name: 'investigate_code',
      arguments: { focus: 'TimeoutError' },
    });
    expect(codeResult.structuredContent).toMatchObject({
      available: true,
      evidenceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      data: {
        status: 'missing_mapping',
        revisions: [],
        evidence: [],
      },
    });

    const result = await client.callTool({
      name: secondaryToolName,
      arguments: { limit: 2 },
    });
    expect(result.structuredContent).toMatchObject({
      available: true,
      evidenceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      data: {
        dataSourceId: secondaryConnectorId,
        dataSourceName: 'Secondary StatusCake',
        service: 'checkout',
        limit: 2,
        tests: ['checkout-web'],
      },
    });
    const evidenceId = (result.structuredContent as { evidenceId: string }).evidenceId;
    const failed = await client.callTool({
      name: secondaryToolName,
      arguments: { limit: 10 },
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      available: false,
      reason: 'error',
      evidenceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const failedEvidenceId = (failed.structuredContent as { evidenceId: string }).evidenceId;
    const audit = await withTenant(appDb.db, tenantId, (tx) =>
      tx
        .select({
          id: agentToolCalls.id,
          tool: agentToolCalls.tool,
          incidentId: agentToolCalls.incidentId,
          outcome: agentToolCalls.outcome,
        })
        .from(agentToolCalls),
    );
    expect(audit).toContainEqual({
      id: evidenceId,
      tool: secondaryToolName,
      incidentId,
      outcome: 'data',
    });
    expect(audit).toContainEqual({
      id: failedEvidenceId,
      tool: secondaryToolName,
      incidentId,
      outcome: 'error',
    });
    await client.close();
  });
});
