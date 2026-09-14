import {
  WorkspaceSettingsMutationError,
  addWorkspaceDomain,
  cancelWorkspaceDeletion,
  createWorkspaceOidcMethod,
  deleteWorkspaceDomain,
  deleteWorkspaceMethod,
  disableWorkspaceMethod,
  enableWorkspaceMethod,
  findDeletingWorkspaceOwner,
  getWorkspaceSettings,
  getWorkspaceDomain,
  listWorkspaceActiveUserIds,
  listDeletingWorkspaces,
  reorderWorkspaceMethods,
  scheduleWorkspaceDeletion,
  setWorkspaceMethodBackchannelLogout,
  configureWorkspaceScim,
  listDirectoryAccounts,
  setWorkspaceRequireDirectory,
  updateWorkspaceMethod,
  updateWorkspaceName,
  type Db,
  type PlatformSecretStore,
} from '@sre/db';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  refuseImpersonatedChange,
  requireTenant,
  requireUser,
  type AuthDeps,
  type AuthVariables,
} from '../auth';
import type { FoundingQueuePort } from './contracts';
import { OidcDiscoveryError, type OidcMetadata } from './oidc-discovery';
import { isPublicEmailDomain } from './validation';
import { oidcRequestOptions } from './oidc-options';
import { newScimCredential, scimProviderState } from '../scim/settings';

const MAX_SETTINGS_BODY_BYTES = 8 * 1024;
const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const methodBody = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    issuer: z.url().max(2_048),
    clientId: z.string().trim().min(1).max(255),
    apiAudience: z.string().trim().min(1).max(2_048).optional(),
    subjectClaim: z.enum(['sub', 'oid']).default('sub'),
    clientAuthentication: z
      .enum(['none', 'client_secret_post', 'client_secret_basic'])
      .default('none'),
    clientSecret: z.string().min(1).max(4_096).optional(),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
    domain: z.string().trim().toLowerCase().regex(domainPattern),
    ...oidcRequestOptions.shape,
  })
  .strict();
const methodUpdateBody = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    sortOrder: z.number().int().min(0).max(10_000),
  })
  .strict();
const methodOrderBody = z.object({ providerIds: z.array(z.uuid()).min(1).max(100) }).strict();
const backchannelLogoutBody = z.object({ enabled: z.boolean(), typRequired: z.boolean() }).strict();
const scimPolicyBody = z
  .object({
    enabled: z.boolean(),
    requireProvisioned: z.boolean(),
    identityAttribute: z.enum(['externalId', 'userName']),
  })
  .strict();
const nameBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const domainBody = z
  .object({ providerId: z.uuid(), domain: z.string().trim().toLowerCase().regex(domainPattern) })
  .strict();
const requireDirectoryBody = z.object({ enabled: z.boolean() }).strict();
const deleteBody = z.object({ confirmSlug: z.string().trim() }).strict();

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

function mutationResponse(c: Context, error: unknown) {
  if (!(error instanceof WorkspaceSettingsMutationError)) throw error;
  const status =
    error.code === 'workspace_not_found' || error.code === 'method_not_found'
      ? 404
      : error.code === 'directory_required_lockout'
        ? 422
        : 409;
  return c.json({ error: error.message, code: error.code, count: error.count }, status);
}

function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const failure = current as { code?: string; cause?: unknown };
    if (failure.code === '23505') return true;
    current = failure.cause;
  }
  return false;
}

function owner(c: Context<{ Variables: AuthVariables }>) {
  return c.get('tenant')?.role === 'owner';
}

/** Builds authenticated workspace settings, sign-in method, domain, and deletion routes. */
export function tenantSettingsRoutes(deps: {
  auth: AuthDeps;
  db: Db;
  clientSecrets?: PlatformSecretStore;
  queue?: FoundingQueuePort;
  discover?: (issuer: string) => Promise<OidcMetadata>;
  checkDomain?: (
    domainId: string,
  ) => Promise<{ status: 'pending' | 'verified' | 'expired' | 'conflict' }>;
}): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  routes.get('/tenant/deletion', requireUser(deps.auth), async (c) => {
    const user = c.get('user');
    return c.json({ workspaces: await listDeletingWorkspaces(deps.db, user) });
  });
  routes.post(
    '/tenant/cancel-deletion',
    bodyLimit({
      maxSize: MAX_SETTINGS_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
    requireUser(deps.auth),
    async (c) => {
      const input = await body(c, deleteBody);
      if (!input) return c.json({ error: 'workspace address confirmation is required' }, 422);
      const user = c.get('user');
      const tenantId = await findDeletingWorkspaceOwner(deps.db, {
        userId: user.userId,
        providerId: user.providerId,
        bindingClaimValue: user.bindingClaimValue,
        slug: input.confirmSlug,
      });
      if (!tenantId) return c.json({ error: 'deleting workspace not found' }, 403);
      try {
        return c.json({ workspace: await cancelWorkspaceDeletion(deps.db, tenantId) });
      } catch (error) {
        return mutationResponse(c, error);
      }
    },
  );
  routes.use('/tenant/*', requireUser(deps.auth), requireTenant());
  // A support session may look at a workspace, never change what it is. Re-checking a domain is
  // the one exception: it reads verification state from DNS rather than writing anything, and a
  // stuck domain is usually why support is looking. Matching on the request path means a later
  // rename of that route stops matching and the session is refused, which is the safe direction.
  routes.use(
    '/tenant/*',
    refuseImpersonatedChange({ except: /^\/tenant\/domains\/[^/]+\/check$/ }),
  );
  routes.use(
    '/tenant/*',
    bodyLimit({
      maxSize: MAX_SETTINGS_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
  );

  routes.get('/tenant/settings', async (c) => {
    const result = await getWorkspaceSettings(deps.db, c.get('tenant')!.tenantId);
    return result ? c.json(result) : c.json({ error: 'workspace not found' }, 404);
  });

  routes.put('/tenant/settings', async (c) => {
    const tenant = c.get('tenant')!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return c.json({ error: 'workspace administrator required' }, 403);
    }
    const input = await body(c, nameBody);
    if (!input) return c.json({ error: 'a valid name is required' }, 422);
    return c.json({ workspace: await updateWorkspaceName(deps.db, tenant.tenantId, input.name) });
  });

  routes.post('/tenant/providers', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    if (!deps.discover) return c.json({ error: 'directory discovery is unavailable' }, 503);
    const input = await body(c, methodBody);
    if (!input) return c.json({ error: 'valid sign-in method details are required' }, 422);
    if (input.clientAuthentication !== 'none' && (!input.clientSecret || !deps.clientSecrets))
      return c.json(
        { error: 'A client secret and encrypted credential storage are required.' },
        422,
      );
    if (isPublicEmailDomain(input.domain)) {
      return c.json({ error: 'use your organisation email domain' }, 422);
    }
    try {
      const created = await createWorkspaceOidcMethod(deps.db, {
        tenantId: c.get('tenant')!.tenantId,
        ...input,
        apiAudience: input.apiAudience ?? null,
        metadata: await deps.discover(input.issuer),
      });
      if (input.clientSecret)
        await deps.clientSecrets!.put(`oidc-client:${created.provider.id}`, input.clientSecret);
      deps.auth.verifiers.invalidate();
      return c.json({ method: created.provider, domain: created.domain }, 201);
    } catch (error) {
      if (uniqueViolation(error)) {
        return c.json({ error: 'this sign-in method or domain is already connected' }, 409);
      }
      if (error instanceof OidcDiscoveryError) {
        return c.json(
          { error: 'We could not reach that directory. Check the URL and try again.' },
          422,
        );
      }
      return mutationResponse(c, error);
    }
  });

  routes.put('/tenant/providers/order', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    const input = await body(c, methodOrderBody);
    if (!input) return c.json({ error: 'every configured method is required once' }, 422);
    try {
      await reorderWorkspaceMethods(deps.db, c.get('tenant')!.tenantId, input.providerIds);
      return c.json({ ordered: true });
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.put('/tenant/providers/:id', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    const input = await body(c, methodUpdateBody);
    if (!input) return c.json({ error: 'valid method details are required' }, 422);
    try {
      return c.json({
        method: await updateWorkspaceMethod(deps.db, {
          tenantId: c.get('tenant')!.tenantId,
          providerId: c.req.param('id'),
          ...input,
        }),
      });
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.put('/tenant/providers/:id/backchannel-logout', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    const input = await body(c, backchannelLogoutBody);
    if (!input) return c.json({ error: 'a valid back-channel logout setting is required' }, 422);
    try {
      const method = await setWorkspaceMethodBackchannelLogout(deps.db, {
        tenantId: c.get('tenant')!.tenantId,
        providerId: c.req.param('id'),
        enabled: input.enabled,
        typRequired: input.typRequired,
      });
      deps.auth.verifiers.invalidate();
      return c.json({ method });
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.post('/tenant/providers/:id/scim/credential', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    const input = await body(c, scimPolicyBody);
    if (!input || !input.enabled) {
      return c.json({ error: 'valid enabled SCIM settings are required' }, 422);
    }
    const generated = newScimCredential();
    try {
      const provider = await configureWorkspaceScim(deps.db, {
        tenantId: c.get('tenant')!.tenantId,
        providerId: c.req.param('id'),
        enabled: true,
        policy: {
          identityAttribute: input.identityAttribute,
          requireProvisioned: input.requireProvisioned,
        },
        credential: generated.credential,
      });
      c.header('cache-control', 'no-store');
      return c.json({ scim: scimProviderState(provider), token: generated.token });
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.put('/tenant/providers/:id/scim', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    const input = await body(c, scimPolicyBody);
    if (!input) return c.json({ error: 'valid SCIM settings are required' }, 422);
    try {
      const provider = await configureWorkspaceScim(deps.db, {
        tenantId: c.get('tenant')!.tenantId,
        providerId: c.req.param('id'),
        enabled: input.enabled,
        policy: {
          identityAttribute: input.identityAttribute,
          requireProvisioned: input.requireProvisioned,
        },
      });
      return c.json({ scim: scimProviderState(provider) });
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.get('/tenant/providers/:id/scim/accounts', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    const settings = await getWorkspaceSettings(deps.db, c.get('tenant')!.tenantId);
    const method = settings?.methods.find(
      (entry) => entry.id === c.req.param('id') && entry.scope === 'tenant',
    );
    if (!method) return c.json({ error: 'workspace sign-in method not found' }, 404);
    const startIndex = Number(c.req.query('startIndex') ?? 1);
    const count = Number(c.req.query('count') ?? 50);
    if (
      !Number.isInteger(startIndex) ||
      startIndex < 1 ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 200
    ) {
      return c.json({ error: 'valid pagination is required' }, 422);
    }
    return c.json(await listDirectoryAccounts(deps.db, method.id, { startIndex, count }));
  });

  for (const action of ['disable', 'enable'] as const) {
    routes.post(`/tenant/providers/:id/${action}`, async (c) => {
      if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
      try {
        const tenantId = c.get('tenant')!.tenantId;
        const method =
          action === 'disable'
            ? await disableWorkspaceMethod(
                deps.db,
                tenantId,
                c.req.param('id'),
                c.get('user').providerId,
              )
            : await enableWorkspaceMethod(deps.db, tenantId, c.req.param('id'));
        deps.auth.verifiers.invalidate();
        if (action === 'disable') await revokeWorkspaceSessions(tenantId);
        return c.json({ method });
      } catch (error) {
        if (uniqueViolation(error)) {
          return c.json({ error: 'this directory is already connected to another workspace' }, 409);
        }
        return mutationResponse(c, error);
      }
    });
  }

  routes.delete('/tenant/providers/:id', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    try {
      await deleteWorkspaceMethod(deps.db, c.get('tenant')!.tenantId, c.req.param('id'));
      deps.auth.verifiers.invalidate();
      return c.json({ deleted: true });
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.post('/tenant/domains', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    const input = await body(c, domainBody);
    if (!input || isPublicEmailDomain(input?.domain ?? '')) {
      return c.json({ error: 'a valid organisation domain is required' }, 422);
    }
    try {
      return c.json(
        {
          domain: await addWorkspaceDomain(deps.db, {
            tenantId: c.get('tenant')!.tenantId,
            ...input,
          }),
        },
        201,
      );
    } catch (error) {
      if (uniqueViolation(error)) return c.json({ error: 'domain is already connected' }, 409);
      return mutationResponse(c, error);
    }
  });

  routes.get('/tenant/domains/:id', async (c) => {
    const domain = await getWorkspaceDomain(deps.db, {
      tenantId: c.get('tenant')!.tenantId,
      domainId: c.req.param('id'),
    });
    return domain ? c.json({ domain }) : c.json({ error: 'Domain not found.' }, 404);
  });
  routes.post('/tenant/domains/:id/check', async (c) => {
    const tenant = c.get('tenant')!;
    // Support sessions are authenticated and checked against platform-admin access by requireUser.
    if (!owner(c) && !(tenant.role === 'admin' && tenant.impersonation))
      return c.json({ error: 'workspace owner or active platform support session required' }, 403);
    if (!deps.checkDomain) return c.json({ error: 'domain check is unavailable' }, 503);
    const settings = await getWorkspaceSettings(deps.db, c.get('tenant')!.tenantId);
    if (!settings?.domains.some((domain) => domain.id === c.req.param('id'))) {
      return c.json({ error: 'email domain not found' }, 404);
    }
    const domain = settings.domains.find((entry) => entry.id === c.req.param('id'))!;
    if (
      !settings.methods.some(
        (method) => method.id === domain.providerId && method.scope === 'tenant',
      )
    ) {
      return c.json({ error: 'this domain is managed by a platform administrator' }, 409);
    }
    const result = await deps.checkDomain(c.req.param('id'));
    deps.auth.verifiers.invalidate();
    return c.json(result);
  });

  routes.delete('/tenant/domains/:id', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    try {
      await deleteWorkspaceDomain(deps.db, c.get('tenant')!.tenantId, c.req.param('id'));
      return c.json({ deleted: true });
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.put('/tenant/settings/require-directory', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    const input = await body(c, requireDirectoryBody);
    if (!input) return c.json({ error: 'enabled must be a boolean' }, 422);
    try {
      const workspace = await setWorkspaceRequireDirectory(deps.db, {
        tenantId: c.get('tenant')!.tenantId,
        actorProviderId: c.get('user').providerId,
        enabled: input.enabled,
      });
      if (input.enabled) await revokeWorkspaceSessions(c.get('tenant')!.tenantId);
      return c.json({ workspace });
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.post('/tenant/delete', async (c) => {
    if (!owner(c)) return c.json({ error: 'workspace owner required' }, 403);
    if (!deps.queue) return c.json({ error: 'workspace deletion is unavailable' }, 503);
    const input = await body(c, deleteBody);
    if (!input) return c.json({ error: 'workspace address confirmation is required' }, 422);
    const tenant = c.get('tenant')!;
    const settings = await getWorkspaceSettings(deps.db, tenant.tenantId);
    if (input.confirmSlug !== settings?.workspace.slug) {
      return c.json({ error: 'type the workspace address to confirm' }, 422);
    }
    const result = await scheduleWorkspaceDeletion(
      deps.db,
      tenant.tenantId,
      deps.queue.insertTenantPurgeTx.bind(deps.queue),
    );
    await revokeWorkspaceSessions(tenant.tenantId);
    await deps.queue.publishJob(result.purge.jobId);
    return c.json({ deleteAfter: result.workspace.deleteAfter });
  });

  async function revokeWorkspaceSessions(tenantId: string) {
    const members = await listWorkspaceActiveUserIds(deps.db, tenantId);
    await Promise.allSettled(
      members.map(({ userId }) => deps.auth.revoke.publish({ userId, tenantId })),
    );
  }

  return routes;
}
