import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { PublicRateLimiter } from './contracts';
import type { makeBrowserSessionRuntime } from './browser-session-runtime';
import { OidcCompletionError } from './oidc-relay';
import { safeErrorMetadata, type Logger } from '../logger';

/** Exposes same-site browser authentication without returning upstream tokens.
 * @param runtime - Server-owned sign-in and session lifecycle.
 * @param limiter - Shared replica-safe public endpoint limiter.
 * @param sourceAddress - Address from the trusted HTTP transport, never a client header.
 * @param log - Optional structured logger for safe completion diagnostics.
 */
export function browserSessionRoutes(
  runtime: ReturnType<typeof makeBrowserSessionRuntime>,
  limiter: PublicRateLimiter,
  sourceAddress: (context: Context) => string,
  log?: Pick<Logger, 'error'>,
) {
  const routes = new Hono();
  routes.onError((error, c) => {
    const metadata = safeErrorMetadata(error);
    log?.error('browser sign-in failed', {
      path: c.req.path,
      ...metadata,
      errorCode: typeof metadata.errorCode === 'string' ? metadata.errorCode : 'sign_in_failed',
    });
    return c.json(
      {
        error:
          error instanceof OidcCompletionError
            ? error.message
            : 'Sign-in could not be completed. Try again or ask your administrator to check this connection.',
        code: error instanceof OidcCompletionError ? error.code : 'sign_in_failed',
      },
      400,
    );
  });
  routes.use('/auth/browser/*', bodyLimit({ maxSize: 8 * 1024 }));
  routes.use('/auth/browser/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (c.req.method !== 'GET' && !runtime.isTrustedRequest(c)) {
      return c.json({ error: 'Request origin could not be verified.' }, 403);
    }
    if (!(await limiter.allow('browser-auth', sourceAddress(c), 120, 60_000))) {
      return c.json({ error: 'Too many sign-in requests. Try again shortly.' }, 429);
    }
    await next();
  });
  routes.get('/auth/browser/session', async (c) => c.json(await runtime.status(c)));
  routes.get('/auth/browser/mailbox', async (c) => c.json(await runtime.mailbox.status(c)));
  routes.post('/auth/browser/resend-email', async (c) => c.json(await runtime.mailbox.resend(c)));
  routes.post('/auth/browser/start', async (c) => {
    const input = z
      .object({
        providerId: z.uuid(),
        foundingId: z.uuid().optional(),
        returnTo: z.string().max(2_048).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: 'Choose a valid sign-in method.' }, 400);
    return c.json(await runtime.start(c, input.data));
  });
  routes.post('/auth/browser/complete', async (c) => {
    const input = z
      .object({ state: z.string().min(1).max(128), code: z.string().min(1).max(4_096) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: 'This sign-in callback is incomplete.' }, 400);
    return c.json(await runtime.complete(c, input.data));
  });
  routes.post('/auth/browser/verify-email', async (c) => {
    const input = z
      .object({ code: z.string().regex(/^\d{8}$/) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json({ error: 'Enter the eight-digit code from your email.' }, 400);
    return c.json(await runtime.verifyMailbox(c, input.data.code));
  });
  routes.post('/auth/browser/logout', async (c) => {
    await runtime.logout(c);
    return c.json({ ok: true });
  });
  routes.post('/auth/browser/workspace', async (c) => {
    const input = z
      .object({ tenantId: z.uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: 'Choose a valid workspace.' }, 400);
    const result = await runtime.selectWorkspace(c, input.data.tenantId);
    if (!result.ok)
      return c.json(
        {
          error:
            'This session cannot open that workspace. Refresh your workspaces or use its required company sign-in.',
        },
        result.status,
      );
    return c.json({ ok: true });
  });
  return routes;
}
