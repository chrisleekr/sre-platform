import { randomUUID } from 'node:crypto';
import { ConnectorRegistry } from '@sre/connectors';
import {
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
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type FetchImplementation, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AuthDeps } from '../../auth';
import { mcpRoutes } from '../../mcp';
import { makeProviderVerifiers } from '../providers';

// Two active providers may legitimately share an issuer, and the verifier table refuses to guess
// between them. Addressing a resource by provider id must not become a way to supply the answer the
// verifier withheld: the path says which provider a client believes it used, never which one
// verified the token.

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const AUDIENCE = 'sre-api';
const SECRET_KEY = Buffer.alloc(32, 3).toString('base64');
const MARKER = randomUUID();
const SHARED_ISSUER = `https://shared-${MARKER}.provider.invalid/`;
const JWKS_URI = `${SHARED_ISSUER}.well-known/jwks.json`;
const KID = 'shared-issuer-key';

let admin: DbHandle;
let appDb: DbHandle;
let app: Hono;
let verifiers: ReturnType<typeof makeProviderVerifiers>;
let tenantId: string;
let incidentId: string;
let subject: string;
let addressedProviderId: string;
let rivalProviderId: string;
let token: string;

let jwks: { keys: JWK[] };

const remoteFetch: FetchImplementation = async (url) =>
  String(url) === JWKS_URI ? Response.json(jwks) : new Response('{}', { status: 404 });

function providerRow(overrides: Partial<typeof identityProviders.$inferInsert>) {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    displayName: `shared-issuer-${MARKER}-${id}`,
    issuer: SHARED_ISSUER,
    jwksUri: JWKS_URI,
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

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  appDb = makeDb(APP_URL);
  tenantId = randomUUID();
  subject = `shared-issuer-${MARKER}`;
  await admin.db.insert(tenants).values({ id: tenantId, name: `shared-issuer-${tenantId}` });
  incidentId = (
    await createIncident(admin.db, tenantId, {
      fingerprint: `shared-issuer-${randomUUID()}`,
      alertSource: 'test',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;

  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });
  jwks = { keys: [jwk] };

  // The partial unique index covers active installation providers only, so a tenant-scoped sibling
  // is a shape the database accepts and the verifier table must therefore survive.
  const addressed = providerRow({});
  const rival = providerRow({ scope: 'tenant' });
  addressedProviderId = addressed.id;
  rivalProviderId = rival.id;
  await admin.db.insert(identityProviders).values([addressed, rival]);

  // Bound and provisioned, so a refusal below can only be the unresolvable issuer.
  await seedMembership(admin.db, { issuer: SHARED_ISSUER, subject }, tenantId);
  await admin.db
    .insert(tenantIdentityBindings)
    .values({ providerId: addressedProviderId, tenantId, claimValue: subject });

  token = await new SignJWT({ sub: subject, scope: 'mcp' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(SHARED_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey);

  verifiers = makeProviderVerifiers(appDb.db, { remoteFetch });
  const auth: AuthDeps = {
    verifiers,
    db: appDb.db,
    adminDb: admin.db,
    settings: { get: async () => 86_400 },
    revoke: { publish: async () => undefined },
  };
  app = new Hono();
  app.route(
    '/',
    mcpRoutes({
      auth,
      db: appDb.db,
      registry: new ConnectorRegistry(),
      secrets: makeSecretStore(appDb.db, SECRET_KEY),
    }),
  );
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await admin.db
      .delete(tenantIdentityBindings)
      .where(eq(tenantIdentityBindings.tenantId, tenantId));
    await admin.db.delete(users).where(eq(users.subject, subject));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.db
      .delete(identityProviders)
      .where(inArray(identityProviders.id, [addressedProviderId, rivalProviderId]));
    await admin.close();
  }
  if (appDb) await appDb.close();
});

describe('ambiguous issuer resolution', () => {
  test('two live providers on one issuer resolve to no verifier at all', async () => {
    await expect(verifiers.byIssuer(SHARED_ISSUER)).resolves.toBeUndefined();
  });

  test('addressing a provider by id does not substitute for the refused issuer lookup', async () => {
    const resource = `/mcp/providers/${addressedProviderId}/incidents/${incidentId}`;

    // Falsifier: the provider-addressed resource exists and this provider id resolves, so the
    // refusal below is the token verification, not a missing route.
    const metadata = await app.request(`/.well-known/oauth-protected-resource${resource}`);
    expect(metadata.status).toBe(200);
    expect((await metadata.json()) as { authorization_servers: string[] }).toMatchObject({
      authorization_servers: [SHARED_ISSUER],
    });

    const response = await app.request(resource, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(incidentId);
  });
});
