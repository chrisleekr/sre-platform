import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  expireWorkspaceFoundings,
  getEditableFounding,
  getEditableFoundingBySlug,
  getFoundingEditState,
  replaceFoundingDraft,
  type Db,
  type PlatformSecretStore,
} from '@sre/db';
import type { setupEditorCookie } from './setup-editor-cookie';
import { oidcFoundingInput } from './founding-input';
import { isPublicEmailDomain, workspaceSlug } from './validation';
import type { OidcMetadata } from './oidc-discovery';
import type { PublicRateLimiter } from './contracts';

/** Exposes non-secret draft settings and browser-authorized replacement before sign-in succeeds.
 * @param deps - Existing setup authorization, discovery and encrypted credential storage.
 */
export function setupEditingRoutes(deps: {
  db: Db;
  setupEditor?: ReturnType<typeof setupEditorCookie>;
  clientSecrets?: PlatformSecretStore;
  oidc?: { discover(issuer: string): Promise<OidcMetadata> };
  limiter?: PublicRateLimiter;
  sourceAddress?: (c: Context) => string;
}) {
  const routes = new Hono();
  routes.get('/workspace-setup-drafts/:slug', async (c) => {
    c.header('Cache-Control', 'no-store');
    const slug = workspaceSlug(c.req.param('slug'));
    if (!slug) return c.json({ error: 'Valid workspace address is required.' }, 400);
    const row = await getEditableFoundingBySlug(deps.db, slug);
    if (!row || !(await deps.setupEditor?.allows(c, row.founding.id, true)))
      return c.json({ error: 'No editable setup belongs to this browser.' }, 404);
    return c.json(await draftProjection(row, deps.clientSecrets));
  });
  routes.use(
    '/foundings/:id/draft',
    bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: 'Request is too large.' }, 413) }),
  );
  routes.use('/foundings/:id/draft', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (
      !/^[a-f0-9-]{36}$/i.test(c.req.param('id') ?? '') ||
      !(await deps.setupEditor?.allows(c, c.req.param('id')!, c.req.method === 'GET'))
    )
      return c.json(
        {
          error:
            'Edit settings in the browser that created this setup. Knowing its address does not grant editing access.',
        },
        403,
      );
    await next();
  });
  routes.get('/foundings/:id/draft', async (c) => {
    const row = await getEditableFounding(deps.db, c.req.param('id'));
    if (!row) {
      const state = await getFoundingEditState(deps.db, c.req.param('id'));
      if (state.disposition === 'continue')
        return c.json(
          {
            error: 'This setup has already moved to approval or provisioning.',
            code: 'setup_in_progress',
            providerId: state.providerId,
          },
          409,
        );
      if (state.disposition === 'authentication')
        return c.json(
          {
            error: 'Sign-in verification is still completing. Retry loading settings shortly.',
            code: 'setup_authentication_in_progress',
            providerId: state.providerId,
          },
          409,
        );
      return c.json(
        {
          error:
            state.disposition === 'expired'
              ? 'This setup has expired. Start a new workspace setup.'
              : 'This setup can no longer be edited. Start a new workspace setup.',
          code: state.disposition === 'expired' ? 'setup_expired' : 'setup_unavailable',
        },
        409,
      );
    }
    return c.json(await draftProjection(row, deps.clientSecrets));
  });
  routes.patch('/foundings/:id/draft', async (c) => {
    const id = c.req.param('id');
    const row = await getEditableFounding(deps.db, id);
    if (!row || !deps.oidc || !deps.clientSecrets)
      return c.json({ error: 'This setup cannot be edited now.' }, 409);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || body.providerId !== row.provider.id)
      return c.json({ error: 'Settings changed. Reload this page before saving.' }, 409);
    let clientSecret = body.clientSecret;
    if (body.keepSecret === true) {
      if (
        body.issuer !== row.provider.issuer ||
        body.clientId !== row.provider.browserClientId ||
        body.clientAuthentication !== row.provider.clientAuthentication
      )
        return c.json({ error: 'Enter a new secret when changing the sign-in application.' }, 400);
      clientSecret = await deps.clientSecrets.get(`oidc-client:${row.provider.id}`);
    }
    const input = oidcFoundingInput({ ...body, clientSecret });
    if (!input || isPublicEmailDomain(input.declaredDomain))
      return c.json(
        { error: 'Check the workspace, work domain and application credentials.' },
        400,
      );
    const newProviderId = randomUUID();
    if (!deps.limiter || !deps.sourceAddress)
      return c.json({ error: 'Directory validation is unavailable.' }, 503);
    try {
      const source = deps.sourceAddress(c);
      if (!(await deps.limiter.allow('founding-discover', source, 20, 60_000)))
        return c.json({ error: 'Too many directory checks. Try again shortly.' }, 429);
    } catch {
      return c.json({ error: 'Directory validation is unavailable.' }, 503);
    }
    let committed = false;
    try {
      const metadata = await deps.oidc.discover(input.issuer);
      await expireWorkspaceFoundings(deps.db, input.slug);
      if (input.clientSecret)
        await deps.clientSecrets.put(`oidc-client:${newProviderId}`, input.clientSecret);
      const updated = await replaceFoundingDraft(deps.db, id, row.provider.id, newProviderId, {
        ...input,
        metadata,
      });
      if (!updated)
        return c.json(
          { error: 'Settings changed or sign-in completed. Reload before continuing.' },
          409,
        );
      committed = true;
      await deps.clientSecrets.delete(`oidc-client:${row.provider.id}`);
      return c.json(updated);
    } catch (error) {
      const failure = error as { code?: string; cause?: { code?: string } };
      return c.json(
        {
          error:
            failure.code === '23505' || failure.cause?.code === '23505'
              ? 'That workspace address is already taken.'
              : 'Settings could not be saved. Check the directory and try again.',
        },
        400,
      );
    } finally {
      if (!committed) await deps.clientSecrets.delete(`oidc-client:${newProviderId}`);
    }
  });
  return routes;
}

async function draftProjection(
  row: NonNullable<Awaited<ReturnType<typeof getEditableFounding>>>,
  secrets?: PlatformSecretStore,
) {
  return {
    foundingId: row.founding.id,
    requestedName: row.founding.requestedName,
    slug: row.founding.slug,
    issuer: row.provider.issuer,
    clientId: row.provider.browserClientId,
    clientAuthentication: row.provider.clientAuthentication,
    domain: row.founding.declaredDomain,
    providerId: row.provider.id,
    secretStored: (await secrets?.has(`oidc-client:${row.provider.id}`)) ?? false,
  };
}
