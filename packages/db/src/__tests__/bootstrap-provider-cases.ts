import { expect, test, vi } from 'vitest';
import { runBootstrap } from '../bootstrap';
import type { DbHandle } from '../client';
import { listPublicProviders } from '../identity-provider-repo';
import {
  bootstrapEnv,
  discovery,
  fixture,
  insertIdentityProviderFixture,
  markerCounts,
  type BootstrapFixture,
  type Discovery,
} from './bootstrap-test-support';

export function registerBootstrapProviderCases(getAdmin: () => DbHandle): void {
  test('persists complete browser metadata from guarded discovery', async () => {
    const admin = getAdmin();
    const value = fixture('default-discovery-success', false);
    const jwksUri = `https://keys.${value.marker}.internal/jwks?version=1`;
    const discover = vi.fn(async () => ({
      issuer: value.provider.issuer,
      jwks_uri: jwksUri,
      authorization_endpoint: `https://${value.marker}.internal/authorize`,
      token_endpoint: `https://${value.marker}.internal/token`,
    }));

    await runBootstrap(bootstrapEnv(value, [value.emailAdmin]), discover);

    expect(discover).toHaveBeenCalledOnce();
    expect(
      (
        await admin.sql`
          select jwks_uri, authorization_endpoint, token_endpoint
          from identity_providers where issuer = ${value.provider.issuer}
        `
      )[0],
    ).toEqual({
      jwks_uri: jwksUri,
      authorization_endpoint: `https://${value.marker}.internal/authorize`,
      token_endpoint: `https://${value.marker}.internal/token`,
    });
    expect(
      (await listPublicProviders(admin.db)).find(
        (provider) => provider.issuer === value.provider.issuer,
      ),
    ).toMatchObject({
      authorizationEndpoint: `https://${value.marker}.internal/authorize`,
      browserClientId: value.provider.browserClientId,
    });
  });

  test('backfills missing browser endpoints on an existing staff provider', async () => {
    const admin = getAdmin();
    const value = fixture('endpoint-backfill');
    const first = await runBootstrap(bootstrapEnv(value), discovery(value));
    await admin.sql`
      update identity_providers
      set authorization_endpoint = null, token_endpoint = null
      where id = ${first.provider.id}
    `;
    const discover = discovery(value);

    await runBootstrap(bootstrapEnv(value), discover);

    expect(discover).toHaveBeenCalledOnce();
    expect(
      (
        await admin.sql`
          select authorization_endpoint, token_endpoint
          from identity_providers where id = ${first.provider.id}
        `
      )[0],
    ).toEqual({
      authorization_endpoint: `https://${value.marker}.example.invalid/authorize`,
      token_endpoint: `https://${value.marker}.example.invalid/token`,
    });
  });

  test('preserves the one existing staff provider when deployment issuer changes', async () => {
    const admin = getAdmin();
    const value = fixture('changed-provider');
    const first = await runBootstrap(bootstrapEnv(value, [value.emailAdmin]), discovery(value));
    const changed: BootstrapFixture = {
      ...value,
      provider: {
        ...value.provider,
        issuer: `https://replacement-${value.marker}.example.invalid/`,
        jwksUri: undefined,
      },
    };
    const mustNotFetch = vi.fn<Discovery>();

    const repeat = await runBootstrap(bootstrapEnv(changed, [value.emailAdmin]), mustNotFetch);

    expect(mustNotFetch).not.toHaveBeenCalled();
    expect(repeat).toEqual({
      provider: { ...first.provider, created: false },
      admins: [
        {
          kind: 'invited',
          email: value.emailAdmin.email,
          invitation: 'already present',
        },
      ],
    });
    expect(
      await admin.sql`select issuer from identity_providers where display_name like ${`%${value.marker}%`}`,
    ).toEqual([{ issuer: value.provider.issuer }]);
    expect(
      await admin.sql`select issuer from platform_admin_invitations where email = ${value.emailAdmin.email}`,
    ).toEqual([{ issuer: value.provider.issuer }]);
  });

  test('backfills a legacy endpoint from the stored issuer when deployment config changed', async () => {
    const admin = getAdmin();
    const value = fixture('changed-provider-backfill');
    const first = await runBootstrap(bootstrapEnv(value), discovery(value));
    await admin.sql`
      update identity_providers
      set token_endpoint = null
      where id = ${first.provider.id}
    `;
    const changed: BootstrapFixture = {
      ...value,
      provider: {
        ...value.provider,
        issuer: `https://replacement-${value.marker}.example.invalid/`,
      },
    };
    const discover = vi.fn(async (requestedIssuer: string) => ({
      issuer: requestedIssuer,
      jwks_uri: `https://${value.marker}.example.invalid/discovered-jwks`,
      authorization_endpoint: `https://${value.marker}.example.invalid/authorize`,
      token_endpoint: `https://${value.marker}.example.invalid/token`,
    }));

    await runBootstrap(bootstrapEnv(changed), discover);

    expect(discover).toHaveBeenCalledWith(value.provider.issuer);
    expect(
      (
        await admin.sql`
          select issuer, authorization_endpoint, token_endpoint
          from identity_providers where id = ${first.provider.id}
        `
      )[0],
    ).toEqual({
      issuer: value.provider.issuer,
      authorization_endpoint: `https://${value.marker}.example.invalid/authorize`,
      token_endpoint: `https://${value.marker}.example.invalid/token`,
    });
  });

  test.each([
    {
      label: 'tenant-scoped',
      scope: 'tenant' as const,
      supportsSignup: false,
      tenantClaim: undefined,
    },
    {
      label: 'signup-capable',
      scope: 'installation' as const,
      supportsSignup: true,
      tenantClaim: undefined,
    },
    {
      label: 'tenant-bound',
      scope: 'installation' as const,
      supportsSignup: false,
      tenantClaim: 'workspace_id',
    },
  ])(
    'does not accept an incompatible $label provider with the configured issuer',
    async (shape) => {
      const admin = getAdmin();
      const value = fixture(`incompatible-${shape.label}`, false);
      await insertIdentityProviderFixture(admin, {
        issuer: value.provider.issuer,
        scope: shape.scope,
        supportsSignup: shape.supportsSignup,
        tenantClaim: shape.tenantClaim,
      });
      const fetchDiscovery = discovery(value);

      await expect(
        runBootstrap(bootstrapEnv(value, [value.emailAdmin]), fetchDiscovery),
      ).rejects.toThrow('not an installation staff provider');
      expect(fetchDiscovery).not.toHaveBeenCalled();
      expect(await markerCounts(admin, value.marker)).toMatchObject({
        providers: 1,
        users: 0,
        invitations: 0,
      });
    },
  );

  test('fails explicitly when more than one active staff provider exists', async () => {
    const admin = getAdmin();
    const value = fixture('multiple-staff', false);
    await insertIdentityProviderFixture(admin, {
      issuer: `https://first-${value.marker}.example.invalid/`,
    });
    await insertIdentityProviderFixture(admin, {
      issuer: `https://second-${value.marker}.example.invalid/`,
    });

    await expect(
      runBootstrap(bootstrapEnv(value, [value.emailAdmin]), discovery(value)),
    ).rejects.toThrow('multiple active installation staff providers exist');
    expect(await markerCounts(admin, value.marker)).toMatchObject({
      providers: 2,
      users: 0,
      invitations: 0,
    });
  });

  test('canonicalizes invitation email casing across reruns', async () => {
    const admin = getAdmin();
    const value = fixture('canonical-email');
    const uppercase = value.emailAdmin.email.toUpperCase();
    const first = await runBootstrap(bootstrapEnv(value, [{ email: uppercase }]), discovery(value));
    const repeat = await runBootstrap(
      bootstrapEnv(value, [{ email: value.emailAdmin.email }]),
      discovery(value),
    );

    expect(first.admins).toEqual([
      { kind: 'invited', email: value.emailAdmin.email, invitation: 'created' },
    ]);
    expect(repeat.admins).toEqual([
      { kind: 'invited', email: value.emailAdmin.email, invitation: 'already present' },
    ]);
    expect(
      await admin.sql`select email from platform_admin_invitations where issuer = ${value.provider.issuer}`,
    ).toEqual([{ email: value.emailAdmin.email }]);
  });
}
