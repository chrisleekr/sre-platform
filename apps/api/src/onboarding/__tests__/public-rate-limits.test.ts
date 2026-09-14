import type { Db } from '@sre/db';
import { describe, expect, test, vi } from 'vitest';
import type { AuthDeps } from '../../auth';
import { authDiscoveryRoutes } from '../auth-discover';
import { foundingRoutes } from '../foundings';

const unavailableDb = (): Db =>
  ({
    select: vi.fn(() => {
      throw new Error('database must not be called');
    }),
  }) as unknown as Db;

describe('public onboarding rate limits', () => {
  test.each([
    {
      name: 'denied',
      expectedStatus: 429,
      limiter: { allow: vi.fn(async () => false) },
      sourceAddress: vi.fn(() => '203.0.113.20'),
    },
    {
      name: 'limiter unavailable',
      expectedStatus: 503,
      limiter: {
        allow: vi.fn(async () => {
          throw new Error('limiter unavailable');
        }),
      },
      sourceAddress: vi.fn(() => '203.0.113.20'),
    },
    {
      name: 'source unavailable',
      expectedStatus: 503,
      limiter: { allow: vi.fn(async () => true) },
      sourceAddress: vi.fn(() => {
        throw new Error('source unavailable');
      }),
    },
  ])('does not query workspace availability when $name', async (scenario) => {
    const db = unavailableDb();
    const response = await authDiscoveryRoutes({
      db,
      limiter: scenario.limiter,
      sourceAddress: scenario.sourceAddress,
    }).request('/workspace-addresses/acme/availability');

    expect(response.status).toBe(scenario.expectedStatus);
    expect(db.select).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'denied',
      expectedStatus: 429,
      limiter: { allow: vi.fn(async () => false) },
      sourceAddress: vi.fn(() => '203.0.113.20'),
    },
    {
      name: 'limiter unavailable',
      expectedStatus: 503,
      limiter: {
        allow: vi.fn(async () => {
          throw new Error('limiter unavailable');
        }),
      },
      sourceAddress: vi.fn(() => '203.0.113.20'),
    },
    {
      name: 'source unavailable',
      expectedStatus: 503,
      limiter: { allow: vi.fn(async () => true) },
      sourceAddress: vi.fn(() => {
        throw new Error('source unavailable');
      }),
    },
  ])('does not load registration policy when founding creation is $name', async (scenario) => {
    const registrationMode = vi.fn(async () => 'closed' as const);
    const response = await foundingRoutes({
      auth: {} as AuthDeps,
      db: unavailableDb(),
      limiter: scenario.limiter,
      registrationMode,
      sourceAddress: scenario.sourceAddress,
    }).request('/foundings', { method: 'POST' });

    expect(response.status).toBe(scenario.expectedStatus);
    expect(registrationMode).not.toHaveBeenCalled();
  });

  // Sign-in method discovery answers an unauthenticated public URL from the control-plane database,
  // so an unusable limiter must close the route rather than leave it unmetered.
  test.each([
    {
      name: 'denied',
      expectedStatus: 429,
      limiter: { allow: vi.fn(async () => false) },
      sourceAddress: vi.fn(() => '203.0.113.20'),
    },
    {
      name: 'limiter unavailable',
      expectedStatus: 503,
      limiter: {
        allow: vi.fn(async () => {
          throw new Error('limiter unavailable');
        }),
      },
      sourceAddress: vi.fn(() => '203.0.113.20'),
    },
    {
      name: 'source unavailable',
      expectedStatus: 503,
      limiter: { allow: vi.fn(async () => true) },
      sourceAddress: vi.fn(() => {
        throw new Error('source unavailable');
      }),
    },
    {
      name: 'the limiter is absent',
      expectedStatus: 503,
      limiter: undefined,
      sourceAddress: vi.fn(() => '203.0.113.20'),
    },
    {
      name: 'the request source is absent',
      expectedStatus: 503,
      limiter: { allow: vi.fn(async () => true) },
      sourceAddress: undefined,
    },
  ])('does not list workspace sign-in methods when $name', async (scenario) => {
    const db = unavailableDb();
    const response = await authDiscoveryRoutes({
      db,
      limiter: scenario.limiter,
      sourceAddress: scenario.sourceAddress,
    }).request('/workspaces/acme/sign-in-methods');

    expect(response.status).toBe(scenario.expectedStatus);
    expect(db.select).not.toHaveBeenCalled();
  });

  test('uses independent buckets for availability and founding creation', async () => {
    const allow = vi.fn(async () => false);
    const sourceAddress = vi.fn(() => '203.0.113.20');

    await authDiscoveryRoutes({
      db: unavailableDb(),
      limiter: { allow },
      sourceAddress,
    }).request('/workspace-addresses/acme/availability');
    await foundingRoutes({
      auth: {} as AuthDeps,
      db: unavailableDb(),
      limiter: { allow },
      registrationMode: vi.fn(async () => 'open' as const),
      sourceAddress,
    }).request('/foundings', { method: 'POST' });

    expect(allow).toHaveBeenNthCalledWith(
      1,
      'workspace-address-availability',
      '203.0.113.20',
      30,
      60_000,
    );
    expect(allow).toHaveBeenNthCalledWith(2, 'founding-create', '203.0.113.20', 20, 60_000);
  });
});
