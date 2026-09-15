import { test, describe, expect, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { users, identityProviders, isPlatformOperator, type DbHandle } from '@sre/db';
import { LOCAL_ISSUER, localAuthRoutes, type LocalLogin } from '../local-auth';

export function registerInactiveLocalAuthCases(
  getFixture: () => {
    db: DbHandle;
    local: LocalLogin;
    api: Pick<Hono, 'request'>;
    reset(): Promise<void>;
    email: string;
    password: string;
    memberships(): Promise<{ tenantId: string }[]>;
  },
) {
  describe('inactive local account refusal', () => {
    test.each(['disabled', 'deleted'] as const)(
      'refuses both local entry paths for a %s identity',
      async (status) => {
        const {
          db: admin,
          api: armedApi,
          reset: resetLocalIdentity,
          email: LOCAL_EMAIL,
          password: LOCAL_PASSWORD,
          memberships: localMemberships,
        } = getFixture();
        await resetLocalIdentity();
        await admin.db
          .insert(users)
          .values({ issuer: LOCAL_ISSUER, subject: LOCAL_EMAIL, status, email: null });
        try {
          for (const path of ['login', 'session']) {
            const response = await armedApi.request(`http://localhost/auth/local/${path}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                origin: 'http://localhost:45173',
                'x-sre-local-development': 'true',
              },
              body: JSON.stringify({ email: LOCAL_EMAIL, password: LOCAL_PASSWORD }),
            });
            expect(response.status).toBe(401);
            expect(
              await admin.db
                .select()
                .from(identityProviders)
                .where(eq(identityProviders.issuer, LOCAL_ISSUER)),
            ).toHaveLength(0);
            expect(await response.json()).toEqual({ error: 'invalid credentials' });
            expect(response.headers.get('cache-control')).toBe('no-store');
          }
          expect(await localMemberships()).toHaveLength(0);
          const [row] = await admin.db
            .select()
            .from(users)
            .where(and(eq(users.issuer, LOCAL_ISSUER), eq(users.subject, LOCAL_EMAIL)));
          expect(row).toMatchObject({ status, email: null });
          expect(await isPlatformOperator(admin.db, row!.id)).toBe(false);
        } finally {
          await resetLocalIdentity();
        }
      },
    );
  });

  test('local sign-in does not turn an unrelated provisioning error into invalid credentials', async () => {
    const {
      db: admin,
      local,
      reset: resetLocalIdentity,
      email: LOCAL_EMAIL,
      password: LOCAL_PASSWORD,
    } = getFixture();
    await resetLocalIdentity();
    const failure = new Error('Settings unavailable');
    const routes = localAuthRoutes({
      local,
      db: admin.db,
      invalidateProviderVerifiers: () => {},
      maxTokenLifetimeSec: async () => {
        throw failure;
      },
      allowAutomaticSession: () => true,
    });
    const errorBoundary = vi.fn((error: Error, c: Context) =>
      c.json({ error: error.message }, 503),
    );
    routes.onError(errorBoundary);
    try {
      for (const path of ['login', 'session']) {
        const response = await routes.request(`/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: LOCAL_EMAIL, password: LOCAL_PASSWORD }),
        });
        expect(response.status).toBe(503);
        expect(errorBoundary.mock.calls.at(-1)?.[0]).toBe(failure);
      }
    } finally {
      await resetLocalIdentity();
    }
  });
}
