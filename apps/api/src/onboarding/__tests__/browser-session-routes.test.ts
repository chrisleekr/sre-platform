import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import type { makeBrowserSessionRuntime } from '../browser-session-runtime';
import { browserSessionRoutes } from '../browser-session-routes';
import { OidcCompletionError } from '../oidc-relay';

describe('browser sign-in diagnostics', () => {
  test('logs the safe OIDC error code without callback credentials', async () => {
    const error = vi.fn();
    const runtime = {
      isTrustedRequest: () => true,
      complete: async () => {
        throw new OidcCompletionError(
          'exchange_failed',
          'provider rejected secret super-sensitive-client-secret',
        );
      },
    } as unknown as ReturnType<typeof makeBrowserSessionRuntime>;
    const app = new Hono();
    app.route(
      '/',
      browserSessionRoutes(runtime, { allow: async () => true }, () => '203.0.113.10', { error }),
    );

    const response = await app.request('/auth/browser/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'browser-state', code: 'authorization-code' }),
    });

    expect(response.status).toBe(400);
    expect(error).toHaveBeenCalledWith('browser sign-in failed', {
      path: '/auth/browser/complete',
      errorType: 'OidcCompletionError',
      errorCode: 'exchange_failed',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('super-sensitive-client-secret');
    expect(JSON.stringify(error.mock.calls)).not.toContain('authorization-code');
  });

  test('keeps a generic coded callback failure actionable without exposing its message', async () => {
    const error = vi.fn();
    const runtime = {
      isTrustedRequest: () => true,
      complete: async () => {
        throw Object.assign(new Error('JWT contains secret-token and invalid claims'), {
          code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
        });
      },
    } as unknown as ReturnType<typeof makeBrowserSessionRuntime>;
    const app = new Hono();
    app.route(
      '/',
      browserSessionRoutes(runtime, { allow: async () => true }, () => '203.0.113.10', { error }),
    );

    const response = await app.request('/auth/browser/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'browser-state', code: 'authorization-code' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'sign_in_failed',
      error:
        'Sign-in could not be completed. Try again or ask your administrator to check this connection.',
    });
    expect(error).toHaveBeenCalledWith('browser sign-in failed', {
      path: '/auth/browser/complete',
      errorType: 'Error',
      errorCode: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-token');
    expect(JSON.stringify(error.mock.calls)).not.toContain('authorization-code');
  });
});
