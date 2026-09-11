// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../authenticatedFetch';
import { setLocalSession } from '../../local-session';
import { clearSessionFailure, getSessionFailure } from '../../session-failure';
import { setImpersonationSession } from '../impersonation';

afterEach(() => {
  setImpersonationSession(null);
  clearSessionFailure();
  vi.unstubAllGlobals();
});

describe('authenticatedFetch', () => {
  test('ignores a delayed 401 from the local token replaced during recovery', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    setLocalSession({ token: 'old', email: 'dev@example.com', expiresAt: Date.now() + 60_000 });
    const pending = authenticatedFetch('http://api/incidents', async () => ({
      kind: 'bearer',
      token: 'old',
    }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    setLocalSession({ token: 'new', email: 'dev@example.com', expiresAt: Date.now() + 60_000 });
    finish(new Response(null, { status: 401 }));
    await pending;
    expect(getSessionFailure()).toBeNull();
    setLocalSession(null);
  });
  test('uses an HttpOnly cookie session without inventing an Authorization header', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await authenticatedFetch('http://api/incidents', async () => ({ kind: 'cookie' }), {
      method: 'POST',
    });
    expect(fetchMock).toHaveBeenCalledWith('http://api/incidents', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-sre-session': '1' },
    });
  });
  test('adds the access token while preserving request headers', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await authenticatedFetch(
      'http://api/incidents',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
    );

    expect(fetchMock).toHaveBeenCalledWith('http://api/incidents', {
      method: 'POST',
      headers: {
        authorization: 'Bearer jwt',
        'content-type': 'application/json',
        'x-sre-session': '1',
      },
      credentials: 'include',
    });
  });

  test('moves a rejected API token into session recovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    await authenticatedFetch('http://api/incidents', async () => ({
      kind: 'bearer' as const,
      token: 'jwt',
    }));
    expect(getSessionFailure()).toBe('unauthorized');
  });

  test('carries one tab-scoped support session and clears it when the API refuses it', async () => {
    setImpersonationSession({
      id: '12345678-1111-4111-8111-111111111111',
      tenantId: '12345678-2222-4222-8222-222222222222',
      tenantName: 'Support workspace',
      reason: 'Diagnose a customer-visible authentication failure',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await authenticatedFetch('http://api/incidents', async () => ({
      kind: 'bearer' as const,
      token: 'jwt',
    }));

    expect(fetchMock).toHaveBeenCalledWith('http://api/incidents', {
      headers: {
        authorization: 'Bearer jwt',
        'x-impersonation-session': '12345678-1111-4111-8111-111111111111',
        'x-sre-session': '1',
      },
      credentials: 'include',
    });
    expect(sessionStorage.getItem('sre-platform.impersonation')).toBeNull();
  });

  test('keeps endpoint authorization failures local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );

    await authenticatedFetch('http://api/platform-settings', async () => ({
      kind: 'bearer' as const,
      token: 'jwt',
    }));
    expect(getSessionFailure()).toBeNull();
  });

  test('moves an interactive token failure into session recovery', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      authenticatedFetch('http://api/incidents', async () => {
        throw { error: 'missing_refresh_token' };
      }),
    ).rejects.toMatchObject({ error: 'missing_refresh_token' });
    expect(getSessionFailure()).toBe('token-unavailable');
  });

  test('leaves transient token failures retryable', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      authenticatedFetch('http://api/incidents', async () => {
        throw { error: 'timeout' };
      }),
    ).rejects.toMatchObject({ error: 'timeout' });
    expect(getSessionFailure()).toBeNull();
  });
});
