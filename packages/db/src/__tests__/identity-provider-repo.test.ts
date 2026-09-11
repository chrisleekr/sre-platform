import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  getProviderForFounding,
  identityProviders,
  listActiveProviders,
  listPublicProviders,
  makeDb,
  platformAdminInvitations,
  type DbHandle,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let releaseProviderTestLock: (() => Promise<void>) | undefined;

beforeAll(() => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
});

beforeEach(async () => {
  const reserved = await admin.sql.reserve();
  await reserved`select pg_advisory_lock(hashtextextended('sre:test:identity-provider', 0))`;
  releaseProviderTestLock = async () => {
    try {
      await reserved`select pg_advisory_unlock(hashtextextended('sre:test:identity-provider', 0))`;
    } finally {
      reserved.release();
    }
  };
});

afterEach(async () => {
  await releaseProviderTestLock?.();
  releaseProviderTestLock = undefined;
});

afterAll(async () => {
  if (app) await app.close();
  if (admin) await admin.close();
});

async function expectSqlState(operation: Promise<unknown>, expected: string): Promise<void> {
  let code: string | undefined;
  try {
    await operation;
  } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } };
    code = failure.code ?? failure.cause?.code;
  }
  expect(code).toBe(expected);
}

async function insertProvider(input: {
  id: string;
  displayName: string;
  issuer: string;
  status: string;
  kind?: string;
  scope?: string;
  supportsSignup?: boolean;
  createdAt?: string;
}): Promise<void> {
  await admin.sql`
    insert into identity_providers (
      id, display_name, issuer, jwks_uri, authorization_endpoint, audience, kind, scope,
      supports_signup, browser_client_id, status, created_at, updated_at
    ) values (
      ${input.id}, ${input.displayName}, ${input.issuer}, ${`${input.issuer}/jwks`},
      ${`${input.issuer}/authorize`}, ${'sre-browser'}, ${input.kind ?? 'oidc'},
      ${input.scope ?? 'installation'}, ${input.supportsSignup ?? false},
      ${`${input.displayName}-client`}, ${input.status},
      ${input.createdAt ?? '2026-09-04T00:00:00.000Z'},
      ${input.createdAt ?? '2026-09-04T00:00:00.000Z'}
    )
  `;
}

describe('identity provider repository', () => {
  test('returns only active public providers in stable creation/id order without internal fields', async () => {
    const prefix = randomUUID();
    const firstId = '10000000-0000-4000-8000-000000000001';
    const secondId = '10000000-0000-4000-8000-000000000002';
    const inactiveId = randomUUID();
    const incompleteEndpointId = randomUUID();
    const incompleteClientId = randomUUID();
    try {
      await insertProvider({
        id: secondId,
        displayName: `Identity test second ${prefix}`,
        issuer: `https://second.${prefix}.invalid`,
        status: 'active',
        createdAt: '2026-09-04T00:00:00.000Z',
      });
      await insertProvider({
        id: firstId,
        displayName: `Identity test first ${prefix}`,
        issuer: `https://first.${prefix}.invalid`,
        status: 'active',
        createdAt: '2026-09-04T00:00:00.000Z',
      });
      await insertProvider({
        id: inactiveId,
        displayName: `Identity test inactive ${prefix}`,
        issuer: `https://inactive.${prefix}.invalid`,
        status: 'disabled',
      });
      await insertProvider({
        id: incompleteEndpointId,
        displayName: `Identity test incomplete endpoint ${prefix}`,
        issuer: `https://incomplete-endpoint.${prefix}.invalid`,
        status: 'active',
      });
      await insertProvider({
        id: incompleteClientId,
        displayName: `Identity test incomplete client ${prefix}`,
        issuer: `https://incomplete-client.${prefix}.invalid`,
        status: 'active',
      });
      await admin.db
        .update(identityProviders)
        .set({ authorizationEndpoint: null })
        .where(eq(identityProviders.id, incompleteEndpointId));
      await admin.db
        .update(identityProviders)
        .set({ browserClientId: null })
        .where(eq(identityProviders.id, incompleteClientId));

      const publicRows = await listPublicProviders(app.db);
      const matching = publicRows.filter((row) => row.displayName.includes(prefix));
      expect(matching.map((row) => row.id)).toEqual([firstId, secondId]);
      expect(matching[0]).toEqual({
        id: firstId,
        displayName: `Identity test first ${prefix}`,
        issuer: `https://first.${prefix}.invalid`,
        authorizationEndpoint: `https://first.${prefix}.invalid/authorize`,
        browserClientId: `Identity test first ${prefix}-client`,
        scope: 'installation',
        supportsSignup: false,
        authorizationScopes: [],
        authorizationAudience: null,
      });
      expect(matching[0]).not.toHaveProperty('jwksUri');

      const activeRows = await listActiveProviders(app.db);
      expect(
        activeRows.filter((row) => row.id === firstId || row.id === secondId).map((row) => row.id),
      ).toEqual([firstId, secondId]);
      expect(activeRows.map((row) => row.id)).toEqual(
        expect.arrayContaining([incompleteEndpointId, incompleteClientId]),
      );
    } finally {
      await admin.sql`delete from identity_providers where display_name like ${`Identity test %${prefix}`}`;
    }
  });

  test('permits duplicate provisional issuers but rejects a second active issuer', async () => {
    const issuer = `https://issuer-${randomUUID()}.invalid`;
    try {
      await insertProvider({
        id: randomUUID(),
        displayName: `Identity test provisional one ${issuer}`,
        issuer,
        status: 'provisional',
      });
      await insertProvider({
        id: randomUUID(),
        displayName: `Identity test provisional two ${issuer}`,
        issuer,
        status: 'provisional',
      });
      await insertProvider({
        id: randomUUID(),
        displayName: `Identity test active ${issuer}`,
        issuer,
        status: 'active',
      });
      await expectSqlState(
        insertProvider({
          id: randomUUID(),
          displayName: `Identity test duplicate active ${issuer}`,
          issuer,
          status: 'active',
        }),
        '23505',
      );
    } finally {
      await admin.sql`delete from identity_providers where issuer = ${issuer}`;
    }
  });

  test('keeps a local provider private while retaining it in active verification inventory', async () => {
    const id = randomUUID();
    const issuer = `urn:sre-platform:test-local:${id}`;
    try {
      await insertProvider({
        id,
        displayName: `Identity test local ${id}`,
        issuer,
        status: 'active',
        kind: 'local',
        scope: 'tenant',
      });

      expect((await listPublicProviders(app.db)).some((row) => row.id === id)).toBe(false);
      expect((await listActiveProviders(app.db)).some((row) => row.id === id)).toBe(true);
    } finally {
      await admin.sql`delete from identity_providers where id = ${id}`;
    }
  });

  test('rejects a second null-claim binding and equivalent verified-domain casing', async () => {
    const providerA = randomUUID();
    const providerB = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const marker = randomUUID();
    try {
      await admin.sql`
        insert into tenants (id, name, slug) values
          (${tenantA}, ${`Identity test tenant A ${marker}`}, ${`identity-test-${tenantA}`}),
          (${tenantB}, ${`Identity test tenant B ${marker}`}, ${`identity-test-${tenantB}`})
      `;
      await insertProvider({
        id: providerA,
        displayName: `Identity test domain A ${marker}`,
        issuer: `https://domain-a-${marker}.invalid`,
        status: 'active',
      });
      await insertProvider({
        id: providerB,
        displayName: `Identity test domain B ${marker}`,
        issuer: `https://domain-b-${marker}.invalid`,
        status: 'active',
      });
      await admin.sql`
        insert into tenant_identity_bindings (tenant_id, provider_id, claim_value)
        values (${tenantA}, ${providerA}, null)
      `;
      await expectSqlState(
        admin.sql`
          insert into tenant_identity_bindings (tenant_id, provider_id, claim_value)
          values (${tenantB}, ${providerA}, null)
        `,
        '23505',
      );

      await admin.sql`
        insert into identity_provider_domains (provider_id, domain, status)
        values (${providerA}, ${`Example-${marker}.COM`}, 'verified')
      `;
      await expectSqlState(
        admin.sql`
          insert into identity_provider_domains (provider_id, domain, status)
          values (${providerB}, ${`example-${marker}.com`}, 'verified')
        `,
        '23505',
      );
    } finally {
      await admin.sql`delete from identity_provider_domains where provider_id in (${providerA}, ${providerB})`;
      await admin.sql`delete from tenant_identity_bindings where provider_id in (${providerA}, ${providerB})`;
      await admin.sql`delete from identity_providers where id in (${providerA}, ${providerB})`;
      await admin.sql`delete from tenants where id in (${tenantA}, ${tenantB})`;
    }
  });

  test('keeps only the declared pre-tenant control-plane tables outside RLS', async () => {
    const rows = await admin.sql<Array<{ table_name: string }>>`
      select c.relname as table_name
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and not c.relrowsecurity
        and exists (
          select 1 from pg_catalog.pg_attribute a
          where a.attrelid = c.oid
            and a.attname = 'tenant_id'
            and a.attnum > 0
            and not a.attisdropped
        )
      order by c.relname
    `;
    expect(rows.map((row) => row.table_name)).toEqual([
      'impersonation_sessions',
      'jobs',
      'memberships',
      'notifications',
      'surface_inbound_events',
      'tenant_identity_bindings',
      'tenant_invitations',
      'workspace_foundings',
    ]);
  });

  test('lets the app role accept an administrator invitation without rewriting its identity', async () => {
    const invitationId = randomUUID();
    const deniedId = randomUUID();
    const email = `identity-test-${invitationId}@example.invalid`;
    try {
      await admin.sql`
        insert into platform_admin_invitations (id, issuer, email)
        values (${invitationId}, 'https://staff.example.invalid', ${email})
      `;
      const selected = await app.sql`
        select id, accepted_at from platform_admin_invitations where id = ${invitationId}
      `;
      expect(selected).toEqual([{ id: invitationId, accepted_at: null }]);
      await app.sql`
        update platform_admin_invitations set accepted_at = now() where id = ${invitationId}
      `;
      expect(
        (
          await admin.db
            .select({ acceptedAt: platformAdminInvitations.acceptedAt })
            .from(platformAdminInvitations)
            .where(eq(platformAdminInvitations.id, invitationId))
        )[0]?.acceptedAt,
      ).toBeInstanceOf(Date);
      await expectSqlState(
        app.sql`
          update platform_admin_invitations
          set email = ${`rewritten-${email}`}
          where id = ${invitationId}
        `,
        '42501',
      );
      await expectSqlState(
        app.sql`
          insert into platform_admin_invitations (id, issuer, email)
          values (${deniedId}, 'https://staff.example.invalid', ${`denied-${email}`})
        `,
        '42501',
      );
      await expectSqlState(
        app.sql`delete from platform_admin_invitations where id = ${invitationId}`,
        '42501',
      );
    } finally {
      await admin.sql`delete from platform_admin_invitations where id in (${invitationId}, ${deniedId})`;
    }
  });

  test('lets the app role read identity providers but denies every mutation', async () => {
    const providerId = randomUUID();
    const deniedId = randomUUID();
    const issuer = `https://read-only-${providerId}.example.invalid/`;
    try {
      await insertProvider({
        id: providerId,
        displayName: `Identity test read only ${providerId}`,
        issuer,
        status: 'active',
        scope: 'tenant',
      });
      expect(await app.sql`select id from identity_providers where id = ${providerId}`).toEqual([
        { id: providerId },
      ]);
      await expectSqlState(
        app.sql`
          insert into identity_providers (
            id, display_name, issuer, jwks_uri, audience, kind, scope, status
          ) values (
            ${deniedId}, 'Denied provider', ${`https://denied-${deniedId}.example.invalid/`},
            ${`https://denied-${deniedId}.example.invalid/jwks`}, 'denied-audience',
            'oidc', 'tenant', 'active'
          )
        `,
        '42501',
      );
      await expectSqlState(
        app.sql`update identity_providers set display_name = 'Denied update' where id = ${providerId}`,
        '42501',
      );
      await expectSqlState(
        app.sql`delete from identity_providers where id = ${providerId}`,
        '42501',
      );
    } finally {
      await admin.sql`delete from identity_providers where id in (${providerId}, ${deniedId})`;
    }
  });

  test('finds a non-active provider only after founder authentication', async () => {
    const providerId = randomUUID();
    const foundingId = randomUUID();
    try {
      await insertProvider({
        id: providerId,
        displayName: `Identity test founding ${foundingId}`,
        issuer: `https://founding-${foundingId}.invalid`,
        status: 'pending_verification',
      });
      await admin.sql`
        insert into workspace_foundings (id, path, slug, requested_name, provider_id, status)
        values (${foundingId}, 'hosted', ${`founding-${foundingId}`}, 'Identity test workspace',
                ${providerId}, 'founder_authenticated')
      `;
      expect(await getProviderForFounding(app.db, foundingId)).toMatchObject({
        id: providerId,
        status: 'pending_verification',
      });
    } finally {
      await admin.sql`delete from workspace_foundings where id = ${foundingId}`;
      await admin.sql`delete from identity_providers where id = ${providerId}`;
    }
  });
});
