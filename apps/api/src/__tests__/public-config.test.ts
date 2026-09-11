import { beforeEach, describe, expect, test, vi } from 'vitest';

const providerRepo = vi.hoisted(() => ({ listPublicProviders: vi.fn() }));

vi.mock('@sre/db', async () => ({
  ...(await vi.importActual<typeof import('@sre/db')>('@sre/db')),
  listPublicProviders: providerRepo.listPublicProviders,
}));

import { makeApp, type AppDeps } from '../app';

const deps = {
  auth: {},
  readinessDb: {},
  appDb: {},
  secrets: {},
  cache: {},
  settings: { list: async () => [], set: async () => 1 },
} as unknown as AppDeps;

const staff = {
  id: '10000000-0000-4000-8000-000000000001',
  displayName: 'Staff identity',
  issuer: 'https://staff.example.invalid',
  authorizationEndpoint: 'https://staff.example.invalid/authorize',
  browserClientId: 'staff-browser',
  scope: 'installation' as const,
  supportsSignup: false,
};
const signup = {
  id: '10000000-0000-4000-8000-000000000002',
  displayName: 'Signup identity',
  issuer: 'https://signup.example.invalid',
  authorizationEndpoint: 'https://signup.example.invalid/authorize',
  browserClientId: 'signup-browser',
  scope: 'installation' as const,
  supportsSignup: true,
};
const tenantStaff = {
  ...staff,
  id: '10000000-0000-4000-8000-000000000003',
  issuer: 'https://tenant-staff.example.invalid',
  scope: 'tenant' as const,
};
const tenantSignup = {
  ...signup,
  id: '10000000-0000-4000-8000-000000000004',
  issuer: 'https://tenant-signup.example.invalid',
  scope: 'tenant' as const,
};

beforeEach(() => {
  providerRepo.listPublicProviders.mockReset();
  vi.restoreAllMocks();
});

describe('GET /public-config', () => {
  test('exposes public installation sign-in options without disclosing tenant directories', async () => {
    providerRepo.listPublicProviders.mockResolvedValue([tenantStaff, tenantSignup, signup, staff]);
    const response = await makeApp(deps).request('/public-config');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      productName: 'SRE Platform',
      productValueLine:
        'Built to work alongside you like a senior SRE: investigate problems, connect evidence across your systems, and help determine what to do next.',
      staffProvider: {
        providerId: staff.id,
        displayName: staff.displayName,
        issuer: staff.issuer,
        browserClientId: staff.browserClientId,
        authorizationEndpoint: staff.authorizationEndpoint,
        scopes: ['openid', 'email', 'profile'],
      },
      signupProvider: {
        providerId: signup.id,
        displayName: signup.displayName,
        issuer: signup.issuer,
        browserClientId: signup.browserClientId,
        authorizationEndpoint: signup.authorizationEndpoint,
        scopes: ['openid', 'email', 'profile'],
      },
      signInProviders: [signup, staff].map((provider) => ({
        providerId: provider.id,
        displayName: provider.displayName,
        issuer: provider.issuer,
        browserClientId: provider.browserClientId,
        authorizationEndpoint: provider.authorizationEndpoint,
        scopes: ['openid', 'email', 'profile'],
      })),
      registrationMode: 'approval_required',
      supportUrl: null,
      termsUrl: null,
      privacyUrl: null,
      termsVersion: null,
    });
    expect(providerRepo.listPublicProviders).toHaveBeenCalledWith(deps.appDb);
    expect(JSON.stringify(body)).not.toContain('jwksUri');
  });

  test('chooses the first stably ordered matching provider and returns null for a missing signup path', async () => {
    const laterStaff = {
      ...staff,
      id: '20000000-0000-4000-8000-000000000002',
      issuer: 'https://later-staff.example.invalid',
    };
    providerRepo.listPublicProviders.mockResolvedValue([staff, laterStaff]);

    const response = await makeApp(deps).request('/public-config');
    expect(await response.json()).toMatchObject({
      staffProvider: {
        issuer: staff.issuer,
        browserClientId: staff.browserClientId,
        authorizationEndpoint: staff.authorizationEndpoint,
      },
      signupProvider: null,
    });
  });

  test('publishes the live registration policy used by founding submission', async () => {
    providerRepo.listPublicProviders.mockResolvedValue([staff]);
    const response = await makeApp({
      ...deps,
      registrationMode: async () => 'open',
    }).request('/public-config');
    expect(await response.json()).toMatchObject({ registrationMode: 'open' });
  });

  test('reads live provider data so an administrator change applies on the next request', async () => {
    providerRepo.listPublicProviders
      .mockResolvedValueOnce([staff])
      .mockResolvedValueOnce([{ ...staff, issuer: 'https://refreshed.example.invalid' }]);
    const app = makeApp(deps);
    const issuer = async (): Promise<string> => {
      const body = (await (await app.request('/public-config')).json()) as {
        staffProvider: { issuer: string };
      };
      return body.staffProvider.issuer;
    };

    expect(await issuer()).toBe(staff.issuer);
    expect(await issuer()).toBe('https://refreshed.example.invalid');
    expect(providerRepo.listPublicProviders).toHaveBeenCalledTimes(2);
  });

  test('does not cache a failed load, so the next unauthenticated request can recover', async () => {
    providerRepo.listPublicProviders
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce([staff]);
    const app = makeApp(deps);

    expect((await app.request('/public-config')).status).toBe(503);
    expect((await app.request('/public-config')).status).toBe(200);
    expect(providerRepo.listPublicProviders).toHaveBeenCalledTimes(2);
  });
});
