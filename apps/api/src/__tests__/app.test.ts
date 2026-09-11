import { describe, expect, test, vi } from 'vitest';
import { makeApp, type AppDeps } from '../app';
import { safeErrorMetadata } from '../logger';

const ORIGIN = 'http://localhost:45173';

/**
 * The routers are only registered here, never invoked: a CORS preflight is answered by the cors
 * middleware and short-circuits before auth or any handler, so the collaborators can be inert.
 */
const deps = {
  auth: {},
  readinessDb: {},
  appDb: {},
  secrets: {},
  cache: {},
  settings: { list: async () => [], set: async () => 1 },
  corsOrigins: [ORIGIN],
} as unknown as AppDeps;

describe('CORS allowMethods', () => {
  // Guards the class of bug where a router registers a verb the allow-list omits: the preflight
  // still succeeds, but the browser blocks the real request. PUT /surfaces/slack hit exactly this.
  test('covers every HTTP method the routers register', async () => {
    const app = makeApp(deps);

    expect(app.routes.map(({ method, path }) => ({ method, path }))).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/platform-settings' },
        { method: 'PUT', path: '/platform-settings/:key' },
      ]),
    );

    // `use('*', cors())` is registered as ALL; only concrete route verbs need to be allow-listed.
    const registered = [
      ...new Set(app.routes.map((r) => r.method.toUpperCase()).filter((m) => m !== 'ALL')),
    ];

    const res = await app.request('/surfaces/slack', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' },
    });
    const allowed = new Set(
      (res.headers.get('access-control-allow-methods') ?? '')
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean),
    );

    expect(registered.filter((m) => !allowed.has(m)).sort()).toEqual([]);

    // index.ts mounts ticketRoutes (POST /ws/ticket) and wsRoutes (GET /ws) on the ROOT app, outside
    // makeApp, so their verbs never appear in app.routes above. They still receive this cors()
    // middleware (Hono copies sub-app route entries, middleware included, into the parent), so their
    // verbs must be allow-listed too. Asserted explicitly rather than by constructing the WS deps.
    expect([...allowed]).toEqual(expect.arrayContaining(['GET', 'POST']));
  });
});

describe('HTTP request observability', () => {
  test('logs completed requests even when authentication rejects them before a route handler', async () => {
    const info = vi.fn();
    const error = vi.fn();
    const app = makeApp({ ...deps, log: { info, error } });

    const res = await app.request('/surfaces');

    expect(res.status).toBe(401);
    expect(info).toHaveBeenCalledWith(
      'http request completed',
      expect.objectContaining({ method: 'GET', path: '/surfaces', status: 401 }),
    );
    expect(error).not.toHaveBeenCalled();
  });
});

describe('safe error metadata', () => {
  test('keeps startup diagnostics useful without exposing raw error content', () => {
    const error = Object.assign(new Error('postgres://user:secret@host/db query failed'), {
      code: '42703',
    });

    const metadata = safeErrorMetadata(error);

    expect(metadata).toEqual({ errorType: 'Error', errorCode: '42703' });
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(metadata)).not.toContain('query failed');
  });
});
