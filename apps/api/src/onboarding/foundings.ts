import {
  FoundingStateError,
  createOidcWorkspaceFounding,
  createWorkspaceFounding,
  expireWorkspaceFoundings,
  getFoundingDomainChallenge,
  getFoundingForUser,
  retryWorkspaceFounding,
  submitWorkspaceFounding,
  type Db,
  type RegistrationMode,
  type PlatformSecretStore,
} from '@sre/db';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requireFoundingUser, type AuthDeps, type AuthVariables } from '../auth';
import type { FoundingQueuePort, PublicRateLimiter } from './contracts';
import { OidcDiscoveryError, type OidcMetadata } from './oidc-discovery';
import { isPublicEmailDomain, workspaceSlug } from './validation';
import type { Notifier } from '@sre/notifications';
import { foundingInput, oidcFoundingInput } from './founding-input';
import type { setupEditorCookie } from './setup-editor-cookie';
import { setupEditingRoutes } from './setup-editing';

const MAX_ONBOARDING_BODY_BYTES = 4 * 1024;

function uniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === '23505' || candidate.cause?.code === '23505';
}

/** Builds public OIDC discovery and founding routes plus founder-owned state transitions. */
export function foundingRoutes(deps: {
  auth: AuthDeps;
  clientSecrets?: PlatformSecretStore;
  setupEditor?: ReturnType<typeof setupEditorCookie>;
  db: Db;
  queue?: FoundingQueuePort;
  limiter?: PublicRateLimiter;
  registrationMode: () => Promise<RegistrationMode>;
  termsVersion?: string | null;
  notifier?: Notifier;
  sourceAddress?: (c: Context) => string;
  oidc?: {
    discover(issuer: string): Promise<OidcMetadata>;
    checkDomain?(
      foundingId: string,
      founderUserId: string,
    ): Promise<{ status: 'pending' | 'verified' | 'expired' | 'conflict' } | null>;
  };
}): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  routes.route('/', setupEditingRoutes(deps));
  for (const path of [
    '/foundings',
    '/foundings/:id',
    '/foundings/:id/retry',
    '/foundings/discover',
    '/foundings/:id/check-domain',
  ]) {
    routes.use(
      path,
      bodyLimit({
        maxSize: MAX_ONBOARDING_BODY_BYTES,
        onError: (c) => c.json({ error: 'payload too large' }, 413),
      }),
    );
  }

  routes.post('/foundings/discover', async (c) => {
    if (!deps.oidc || !deps.limiter || !deps.sourceAddress) {
      return c.json({ error: 'OIDC discovery is unavailable' }, 503);
    }
    try {
      const source = deps.sourceAddress(c);
      if (!(await deps.limiter.allow('founding-discover', source, 20, 60_000))) {
        return c.json({ error: 'too many OIDC discovery requests' }, 429);
      }
    } catch {
      return c.json({ error: 'OIDC discovery is unavailable' }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as { issuer?: unknown } | null;
    const issuer = typeof body?.issuer === 'string' ? body.issuer.trim() : '';
    if (!issuer || issuer.length > 2_048) return c.json({ error: 'valid issuer is required' }, 400);
    try {
      return c.json({ provider: await deps.oidc.discover(issuer) });
    } catch (error) {
      if (error instanceof OidcDiscoveryError)
        return c.json(
          {
            error: 'We could not reach that directory. Check the URL and try again.',
            code: 'directory_unreachable',
          },
          400,
        );
      return c.json({ error: 'OIDC discovery failed' }, 400);
    }
  });

  routes.post('/foundings', async (c) => {
    if (!deps.limiter) return c.json({ error: 'workspace registration is unavailable' }, 503);
    try {
      if (!deps.sourceAddress) throw new Error('request source resolver is unavailable');
      const source = deps.sourceAddress(c);
      if (!(await deps.limiter.allow('founding-create', source, 20, 60_000))) {
        return c.json({ error: 'too many workspace registration requests' }, 429);
      }
    } catch {
      return c.json({ error: 'workspace registration is unavailable' }, 503);
    }
    if ((await deps.registrationMode()) === 'closed') {
      return c.json(
        { error: 'workspace registration is closed', code: 'registration_closed' },
        403,
      );
    }
    const body: unknown = await c.req.json().catch(() => null);
    const input = deps.oidc ? oidcFoundingInput(body) : foundingInput(body);
    if (!input || (body as { path?: unknown }).path !== 'own_directory') {
      return c.json(
        { error: 'valid own-directory workspace details are required', code: 'invalid_workspace' },
        400,
      );
    }
    if (input.declaredDomain && isPublicEmailDomain(input.declaredDomain)) {
      return c.json(
        { error: 'use your organisation email domain', code: 'public_email_domain' },
        400,
      );
    }
    try {
      if (deps.oidc) {
        const oidcInput = input as NonNullable<ReturnType<typeof oidcFoundingInput>>;
        const metadata = await deps.oidc.discover(oidcInput.issuer);
        if (oidcInput.clientAuthentication !== 'none' && !deps.clientSecrets) {
          return c.json({ error: 'Encrypted client credential storage is unavailable.' }, 503);
        }
        await expireWorkspaceFoundings(deps.db, oidcInput.slug);
        const created = await createOidcWorkspaceFounding(deps.db, {
          slug: oidcInput.slug,
          requestedName: oidcInput.requestedName,
          declaredDomain: oidcInput.declaredDomain,
          clientId: oidcInput.clientId,
          clientAuthentication: oidcInput.clientAuthentication,
          apiAudience: oidcInput.apiAudience,
          subjectClaim: oidcInput.subjectClaim,
          authorizationScopes: oidcInput.authorizationScopes,
          authorizationAudience: oidcInput.authorizationAudience,
          metadata,
        });
        if (oidcInput.clientSecret)
          await deps.clientSecrets!.put(
            `oidc-client:${created.provider.id}`,
            oidcInput.clientSecret,
          );
        await deps.setupEditor?.grant(c, created.founding.id);
        return c.json(
          {
            founding: created.founding,
            provider: {
              id: created.provider.id,
              issuer: metadata.issuer,
              authorizationEndpoint: metadata.authorizationEndpoint,
              browserClientId: oidcInput.clientId,
              authorizationScopes: oidcInput.authorizationScopes,
              authorizationAudience: oidcInput.authorizationAudience,
            },
          },
          201,
        );
      }
      await expireWorkspaceFoundings(deps.db, input.slug);
      const founding = await createWorkspaceFounding(deps.db, {
        path: 'own_directory',
        ...input,
      });
      return c.json({ founding }, 201);
    } catch (error) {
      if (error instanceof OidcDiscoveryError)
        return c.json(
          {
            error: 'We could not reach that directory. Check the URL and try again.',
            code: 'directory_unreachable',
          },
          400,
        );
      if (uniqueViolation(error))
        return c.json(
          { error: 'workspace address already exists', code: 'workspace_address_taken' },
          409,
        );
      throw error;
    }
  });

  for (const path of ['/foundings/:id', '/foundings/:id/retry', '/foundings/:id/check-domain']) {
    routes.use(path, requireFoundingUser(deps.auth));
  }
  routes.get('/foundings/:id', async (c) => {
    const [founding, domain] = await Promise.all([
      getFoundingForUser(deps.db, c.req.param('id'), c.get('user').userId),
      getFoundingDomainChallenge(deps.db, c.req.param('id'), c.get('user').userId),
    ]);
    return founding ? c.json({ founding, domain }) : c.json({ error: 'founding not found' }, 404);
  });
  routes.post('/foundings/:id/check-domain', async (c) => {
    if (!deps.oidc?.checkDomain)
      return c.json({ error: 'domain verification is unavailable' }, 503);
    if (!deps.limiter || !deps.sourceAddress) {
      return c.json({ error: 'domain verification is unavailable' }, 503);
    }
    const foundingId = c.req.param('id');
    const userId = c.get('user').userId;
    try {
      const source = deps.sourceAddress(c);
      const key = `${userId}:${foundingId}:${source}`;
      if (!(await deps.limiter.allow('founding-domain-check', key, 6, 60_000))) {
        return c.json({ error: 'too many domain verification requests' }, 429);
      }
    } catch {
      return c.json({ error: 'domain verification is unavailable' }, 503);
    }
    const result = await deps.oidc.checkDomain(foundingId, userId);
    return result ? c.json(result) : c.json({ error: 'founding not found' }, 404);
  });
  routes.put('/foundings/:id', async (c) => {
    if (!deps.queue) return c.json({ error: 'workspace provisioning is unavailable' }, 503);
    const body: unknown = await c.req.json().catch(() => null);
    const input = foundingInput(body);
    if (!input)
      return c.json(
        { error: 'valid workspace details are required', code: 'invalid_workspace' },
        400,
      );
    const acceptedTerms =
      typeof (body as { termsAcceptedVersion?: unknown } | null)?.termsAcceptedVersion === 'string'
        ? (body as { termsAcceptedVersion: string }).termsAcceptedVersion
        : undefined;
    if (deps.termsVersion && acceptedTerms !== deps.termsVersion) {
      return c.json({ error: 'terms acceptance is required', code: 'terms_required' }, 400);
    }
    try {
      const result = await submitWorkspaceFounding(deps.db, {
        foundingId: c.req.param('id'),
        founderUserId: c.get('user').userId,
        requestedName: input.requestedName,
        slug: input.slug,
        registrationMode: await deps.registrationMode(),
        requiredTermsVersion: deps.termsVersion ?? undefined,
        ...(acceptedTerms ? { termsAcceptedVersion: acceptedTerms } : {}),
        insertJobTx: deps.queue.insertProvisionTx.bind(deps.queue),
      });
      if (result.jobId) await deps.queue.publishJob(result.jobId).catch(() => undefined);
      if (result.status === 'approved') {
        await deps.notifier?.notify(
          { userId: c.get('user').userId },
          'founding.approved',
          { workspaceName: result.requestedName },
          { eventKey: `founding:${result.id}:approved` },
        );
      }
      return c.json({ founding: result }, result.jobId ? 202 : 200);
    } catch (error) {
      if (error instanceof FoundingStateError) {
        if (error.code === 'registration_closed' || error.code === 'terms_required') {
          return c.json({ error: error.message, code: error.code }, 403);
        }
        return c.json({ error: 'founding not found' }, 404);
      }
      if (uniqueViolation(error)) {
        return c.json(
          { error: 'workspace address already exists', code: 'workspace_address_taken' },
          409,
        );
      }
      throw error;
    }
  });
  routes.post('/foundings/:id/retry', async (c) => {
    if (!deps.queue) return c.json({ error: 'workspace provisioning is unavailable' }, 503);
    const body: unknown = await c.req.json().catch(() => null);
    const slug =
      typeof (body as { slug?: unknown } | null)?.slug === 'string'
        ? (body as { slug: string }).slug.trim().toLowerCase()
        : '';
    if (!workspaceSlug(slug)) return c.json({ error: 'valid workspace address is required' }, 400);
    try {
      const result = await retryWorkspaceFounding(deps.db, {
        foundingId: c.req.param('id'),
        founderUserId: c.get('user').userId,
        slug,
        insertJobTx: deps.queue.insertProvisionTx.bind(deps.queue),
      });
      await deps.queue.publishJob(result.jobId).catch(() => undefined);
      return c.json({ founding: result }, 202);
    } catch (error) {
      if (error instanceof FoundingStateError) {
        if (error.code === 'founding_job_busy') {
          return c.json({ error: error.message, code: error.code }, 409);
        }
        return c.json({ error: 'founding not found' }, 404);
      }
      if (uniqueViolation(error)) {
        return c.json(
          { error: 'workspace address already exists', code: 'workspace_address_taken' },
          409,
        );
      }
      throw error;
    }
  });
  return routes;
}
