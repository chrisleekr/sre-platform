import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { allowLocalAutoLogin, localDevelopmentLoginOrigin } from '../local-development-auth';
import { armLocalLogin, localLoginCredentials, localAuthRoutes } from '../local-auth';
import type { Db } from '@sre/db';

const origin = 'http://localhost:45173';
const env = {
  ALLOW_LOCAL_DEVELOPMENT_LOGIN: 'true',
  NODE_ENV: 'development',
  LOCAL_LOGIN_EMAIL: 'dev@example.test',
};

describe('automatic login configuration', () => {
  test('off by default and armed without any password', () => {
    expect(localDevelopmentLoginOrigin({})).toBeUndefined();
    expect(localDevelopmentLoginOrigin(env)).toBe(origin);
    expect(localLoginCredentials(env)).toEqual({ email: env.LOCAL_LOGIN_EMAIL });
  });
  test.each(['production', 'staging', 'prod', 'test', '', undefined])(
    'refuses NODE_ENV=%s',
    (NODE_ENV) => {
      expect(() => localLoginCredentials({ ...env, NODE_ENV })).toThrow(
        'requires NODE_ENV=development',
      );
    },
  );
  test.each([
    'https://example.test',
    'http://localhost.evil.test',
    'http://user@localhost',
    'http://localhost/path',
    'http://localhost/?query',
    'file:///tmp',
    'not a url',
  ])('refuses origin %s', (DASHBOARD_BASE_URL) => {
    expect(() => localDevelopmentLoginOrigin({ ...env, DASHBOARD_BASE_URL })).toThrow();
  });
  test('requires a configured identity and rejects proxy trust', () => {
    expect(() => localLoginCredentials({ ...env, LOCAL_LOGIN_EMAIL: '' })).toThrow(
      'LOCAL_LOGIN_EMAIL',
    );
    expect(() => localDevelopmentLoginOrigin({ ...env, TRUST_PROXY_HOPS: '1' })).toThrow(
      'reverse proxies',
    );
  });
  test('automatic-only mode cannot authenticate an empty password', async () => {
    const local = await armLocalLogin(
      { email: env.LOCAL_LOGIN_EMAIL },
      { audience: 'test', log() {} },
    );
    expect(local.verify(env.LOCAL_LOGIN_EMAIL, '')).toBe(false);
    const api = localAuthRoutes({
      local,
      db: {} as Db,
      invalidateProviderVerifiers() {},
      maxTokenLifetimeSec: async () => 900,
    });
    expect((await api.request('/login', { method: 'POST' })).status).toBe(404);
    expect((await api.request('/session', { method: 'POST' })).status).toBe(404);
  });
});

describe('automatic login request boundary', () => {
  test('requires the configured email before provisioning or minting', async () => {
    const local = await armLocalLogin({ email: 'dev@example.com' }, { audience: 'test', log() {} });
    const routes = localAuthRoutes({
      local,
      db: {} as Db,
      invalidateProviderVerifiers() {},
      maxTokenLifetimeSec: async () => 900,
      allowAutomaticSession: () => true,
    });
    expect((await routes.request('/session', { method: 'POST', body: '{}' })).status).toBe(400);
    const unknown = await routes.request('/session', {
      method: 'POST',
      body: JSON.stringify({ email: 'person@example.com' }),
    });
    expect(await unknown.json()).toEqual({ matched: false });
  });
  const headers = { origin, 'x-sre-local-development': 'true' };
  async function request(
    peer: string | undefined,
    url = 'http://localhost/session',
    extra: Record<string, string> = headers,
  ) {
    const app = new Hono();
    app.post('/session', (c) => c.json({ allowed: allowLocalAutoLogin(c, origin, peer) }));
    return (await app.request(url, { method: 'POST', headers: extra })).json();
  }
  test.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'accepts actual loopback peer %s',
    async (peer) => {
      expect(await request(peer)).toEqual({ allowed: true });
    },
  );
  test.each(['192.168.1.2', '10.0.0.1', 'localhost', undefined])(
    'rejects peer %s',
    async (peer) => {
      expect(await request(peer)).toEqual({ allowed: false });
    },
  );
  test.each(['http://attacker.test/session', 'http://localhost.attacker.test/session'])(
    'rejects rebinding host %s',
    async (url) => {
      expect(await request('127.0.0.1', url)).toEqual({ allowed: false });
    },
  );
  const rejectedHeaders: Record<string, string>[] = [
    {},
    { origin },
    { ...headers, origin: 'null' },
    { ...headers, origin: 'http://localhost:1234' },
    { ...headers, 'x-forwarded-for': '127.0.0.1' },
    { ...headers, forwarded: 'for=127.0.0.1' },
    { ...headers, 'x-forwarded-host': 'localhost' },
  ];
  test.each(rejectedHeaders)('rejects cross-site or forwarded requests: %j', async (extra) => {
    expect(await request('127.0.0.1', undefined, extra)).toEqual({ allowed: false });
  });
});
