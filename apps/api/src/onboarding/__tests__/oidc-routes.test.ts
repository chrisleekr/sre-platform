import { beforeEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
const repo = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@sre/db', async () => ({
  ...(await vi.importActual('@sre/db')),
  getActiveOidcProviderById: repo.get,
}));
import { oidcRoutes } from '../oidc-routes';
const id = '10000000-0000-4000-8000-000000000001';
const api = new Hono().route('/', oidcRoutes({ db: {} as never }));
beforeEach(() => repo.get.mockReset());
test('projects only non-secret metadata for an active provider', async () => {
  repo.get.mockResolvedValue({
    id,
    issuer: 'https://directory.example',
    authorizationEndpoint: 'https://directory.example/authorize',
    browserClientId: 'browser',
    audience: 'api-only',
  });
  const response = await api.request(`/auth/oidc/providers/${id}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    providerId: id,
    issuer: 'https://directory.example',
    authorizationEndpoint: 'https://directory.example/authorize',
    clientId: 'browser',
    scopes: ['openid', 'email', 'profile'],
  });
});
test('rejects malformed and unavailable providers', async () => {
  expect((await api.request('/auth/oidc/providers/not-an-id')).status).toBe(404);
  expect(repo.get).not.toHaveBeenCalled();
  repo.get.mockResolvedValue(null);
  expect((await api.request(`/auth/oidc/providers/${id}`)).status).toBe(404);
});
test.each(['exchange', 'refresh'])(
  'does not expose the obsolete %s browser-token route',
  async (operation) => {
    expect((await api.request(`/auth/oidc/${operation}`, { method: 'POST' })).status).toBe(404);
  },
);
