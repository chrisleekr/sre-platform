import { randomUUID } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { ConnectorRegistry } from '@sre/connectors';
import {
  agentToolCalls,
  createIncident,
  identityProviders,
  incidents,
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { seedMembership } from '@sre/db/test-support';
import { eq, inArray } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair, type FetchImplementation, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AuthDeps } from '../auth';
import { makeProviderVerifiers } from '../auth/providers';
import { makeApp } from '../app';

// The incident MCP resource is addressed per identity provider, so the protected-resource metadata
// a client discovers must name exactly the one authorization server that can mint a token for it,
// and a token minted elsewhere must be refused the same way an invalid one is. Real provider
// verifiers are used throughout: a stub that answers one issuer could not fail these.

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const AUDIENCE = 'sre-api';
const SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
const MARKER = randomUUID();

interface SeededProvider {
  id: string;
  issuer: string;
  subject: string;
  sign(claims: Record<string, unknown>): Promise<string>;
}

let admin: DbHandle;
let appDb: DbHandle;
let api: ReturnType<typeof makeApp>;
let tenantId: string;
let incidentId: string;
let providerA: SeededProvider;
let providerB: SeededProvider;
let disabledProviderId: string;
let localProviderId: string;
let tokenA: string;
let tokenB: string;

const jwksByUri = new Map<string, { keys: JWK[] }>();
const providerIds: string[] = [];
const subjects: string[] = [];

const remoteFetch: FetchImplementation = async (url) => {
  const jwks = jwksByUri.get(String(url));
  return jwks ? Response.json(jwks) : new Response('{}', { status: 404 });
};

function providerRow(overrides: Partial<typeof identityProviders.$inferInsert> = {}) {
  const id = overrides.id ?? randomUUID();
  const issuer = overrides.issuer ?? `https://${id}.mcp-boundary.invalid/`;
  return {
    id,
    displayName: `mcp-boundary-${MARKER}-${id}`,
    issuer,
    jwksUri: `${issuer}.well-known/jwks.json`,
    audience: AUDIENCE,
    kind: 'oidc' as const,
    scope: 'installation' as const,
    supportsSignup: false,
    emailClaim: 'email',
    subjectClaim: 'sub',
    tenantClaim: 'sub',
    status: 'active' as const,
    ...overrides,
  };
}

/** Inserts one active OIDC provider with a live local key set and a tenant binding. */
async function seedProvider(label: string): Promise<SeededProvider> {
  const row = providerRow();
  const kid = `${label}-key`;
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid, alg: 'RS256', use: 'sig' });
  jwksByUri.set(row.jwksUri, { keys: [jwk] });
  await admin.db.insert(identityProviders).values(row);
  providerIds.push(row.id);
  const subject = `mcp-${label}-${MARKER}`;
  subjects.push(subject);
  await seedMembership(admin.db, { issuer: row.issuer, subject }, tenantId);
  await admin.db
    .insert(tenantIdentityBindings)
    .values({ providerId: row.id, tenantId, claimValue: subject });
  return {
    id: row.id,
    issuer: row.issuer,
    subject,
    sign: (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(row.issuer)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(pair.privateKey),
  };
}

function resourcePath(providerId: string, incident: string): string {
  return `/mcp/providers/${providerId}/incidents/${incident}`;
}

function metadataPath(providerId: string, incident: string): string {
  return `/.well-known/oauth-protected-resource${resourcePath(providerId, incident)}`;
}

async function callResource(
  providerId: string,
  incident: string,
  token?: string,
): Promise<Response> {
  return api.request(resourcePath(providerId, incident), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

async function metadataBody(providerId: string, incident: string) {
  const response = await api.request(metadataPath(providerId, incident));
  expect(response.status).toBe(200);
  return (await response.json()) as { resource: string; authorization_servers: string[] };
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  appDb = makeDb(APP_URL);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: `mcp-boundary-${tenantId}` });
  incidentId = (
    await createIncident(admin.db, tenantId, {
      fingerprint: `mcp-boundary-${randomUUID()}`,
      alertSource: 'test',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;

  providerA = await seedProvider('a');
  providerB = await seedProvider('b');

  const disabled = providerRow({ status: 'disabled' });
  const local = providerRow({ kind: 'local', scope: 'tenant' });
  await admin.db.insert(identityProviders).values([disabled, local]);
  providerIds.push(disabled.id, local.id);
  disabledProviderId = disabled.id;
  localProviderId = local.id;

  tokenA = await providerA.sign({ sub: providerA.subject, scope: 'mcp' });
  tokenB = await providerB.sign({ sub: providerB.subject, scope: 'mcp' });

  const auth: AuthDeps = {
    verifiers: makeProviderVerifiers(appDb.db, { remoteFetch }),
    db: appDb.db,
    adminDb: admin.db,
    settings: { get: async () => 86_400 },
    revoke: { publish: async () => undefined },
  };
  api = makeApp({
    auth,
    readinessDb: appDb.db,
    appDb: appDb.db,
    secrets: makeSecretStore(appDb.db, SECRET_KEY),
    registry: new ConnectorRegistry(),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(agentToolCalls).where(eq(agentToolCalls.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await admin.db
      .delete(tenantIdentityBindings)
      .where(eq(tenantIdentityBindings.tenantId, tenantId));
    await admin.db.delete(users).where(inArray(users.subject, subjects));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.db.delete(identityProviders).where(inArray(identityProviders.id, providerIds));
    await admin.close();
  }
  if (appDb) await appDb.close();
});

describe('provider-addressed incident MCP resource', () => {
  test('metadata names exactly the authorization server that owns the resource', async () => {
    const body = await metadataBody(providerA.id, incidentId);

    expect(body.authorization_servers).toEqual([providerA.issuer]);
    expect(body.resource).toContain(providerA.id);
    expect(body.resource).toContain(incidentId);
  });

  test('metadata for one provider never advertises another live provider', async () => {
    const first = await metadataBody(providerA.id, incidentId);
    const second = await metadataBody(providerB.id, incidentId);

    // Both providers are active, so the absence below is a scoping decision, not an empty table.
    expect(second.authorization_servers).toEqual([providerB.issuer]);
    expect(first.authorization_servers).not.toContain(providerB.issuer);
    expect(second.authorization_servers).not.toContain(providerA.issuer);
  });

  test('a disabled, non-OIDC or unknown provider gives the same refusal', async () => {
    // Falsifier: the same shape answers 200 for a usable provider, so the identical 404s below
    // cannot be the router failing to recognise the path at all.
    expect((await api.request(metadataPath(providerA.id, incidentId))).status).toBe(200);

    const refusals = await Promise.all(
      [
        metadataPath('not-a-provider-id', incidentId),
        metadataPath(randomUUID(), incidentId),
        metadataPath(disabledProviderId, incidentId),
        metadataPath(localProviderId, incidentId),
        metadataPath(providerA.id, 'not-an-incident-id'),
      ].map(async (path) => {
        const response = await api.request(path);
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: await response.text(),
        };
      }),
    );

    expect(refusals[0]!.status).toBe(404);
    for (const refusal of refusals) expect(refusal).toEqual(refusals[0]);
  });

  test('the resource route refuses the same set before the bearer gate is reached', async () => {
    // Falsifier: the route exists and a usable provider reaches the bearer gate, so the identical
    // 404s below are the resource route's own guard and not a missing route or an auth challenge.
    const gated = await callResource(providerA.id, incidentId);
    expect(gated.status).toBe(401);
    expect(gated.headers.get('www-authenticate')).toContain('resource_metadata=');

    const refusals = await Promise.all(
      [
        ['not-a-provider-id', incidentId],
        [randomUUID(), incidentId],
        [disabledProviderId, incidentId],
        [localProviderId, incidentId],
        [providerA.id, 'not-an-incident-id'],
      ].map(async ([addressedProviderId, addressedIncidentId]) => {
        const response = await callResource(addressedProviderId!, addressedIncidentId!, tokenA);
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          // A challenge here would mean the guard had moved behind the bearer gate, turning a
          // disabled provider into a 401 that an unknown one does not produce.
          challenge: response.headers.get('www-authenticate'),
          body: await response.text(),
        };
      }),
    );

    expect(refusals[0]!.status).toBe(404);
    expect(refusals[0]!.challenge).toBeNull();
    for (const refusal of refusals) expect(refusal).toEqual(refusals[0]);
  });

  test('the addressed provider is matched whatever the case of its hex digits', async () => {
    // A uuid literal accepts upper-case hex, and Postgres returns the lower-case canonical form.
    const upper = providerA.id.toUpperCase();
    expect(upper).not.toBe(providerA.id);

    const metadata = await api.request(metadataPath(upper, incidentId));
    expect(metadata.status).toBe(200);
    const body = (await metadata.json()) as { resource: string; authorization_servers: string[] };
    expect(body.authorization_servers).toEqual([providerA.issuer]);
    // The advertised resource must be the canonical id, or it names a URL that can never verify.
    expect(body.resource).toContain(providerA.id);

    expect((await callResource(upper, incidentId, tokenA)).status).not.toBe(401);
  });

  test('metadata is served without looking the incident up', async () => {
    const unknownIncidentId = randomUUID();
    const body = await metadataBody(providerA.id, unknownIncidentId);

    expect(body.authorization_servers).toEqual([providerA.issuer]);
    expect(body.resource).toContain(unknownIncidentId);
  });

  test("a token from one provider cannot open another provider's resource", async () => {
    const foreign = await callResource(providerB.id, incidentId, tokenA);
    const invalid = await callResource(providerB.id, incidentId, 'not-a-token');

    expect(foreign.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(foreign.headers.get('www-authenticate')).toBe(invalid.headers.get('www-authenticate'));
    expect(foreign.headers.get('www-authenticate')).toContain('resource_metadata=');
    // The refusal must not leak that the token itself was well formed and verifiable.
    expect(await foreign.text()).toBe(await invalid.text());

    // Falsifier: provider B's resource does admit provider B's own token.
    expect((await callResource(providerB.id, incidentId, tokenB)).status).not.toBe(401);
  });

  test('a token from the addressed provider opens the incident tool session', async () => {
    const endpoint = new URL(`http://sre.test${resourcePath(providerA.id, incidentId)}`);
    const fetchImpl: FetchLike = async (input, init) => {
      const request =
        input instanceof Request
          ? input
          : new Request(typeof input === 'string' ? input : input.toString(), init);
      return api.fetch(request);
    };
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: { token: async () => tokenA },
      fetch: fetchImpl,
    });
    const client = new Client(
      { name: 'sre-platform-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain('search_incident_evidence');
      expect(names).toContain('investigate_code');
      expect(names).toContain('resolve_entity_context');
    } finally {
      await client.close();
    }
  });
});
