import {
  PROVIDER_STATUSES,
  identityProviders,
  listAdminProviders,
  listDirectoryAccounts,
  configureAdminScim,
  updateAdminProvider,
} from '@sre/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminRoutesDeps, AdminVariables } from './contracts';
import { adminBody, adminMutationResponse } from './support';
import { newScimCredential, scimProviderState } from '../scim/settings';

function safeHttpsUrl(value: string, allowQuery: boolean): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (allowQuery || !url.search)
    );
  } catch {
    return false;
  }
}

const endpointUrl = z
  .string()
  .trim()
  .max(2_000)
  .refine((value) => safeHttpsUrl(value, true), 'endpoint must be a safe HTTPS URL');
const issuerUrl = z
  .string()
  .trim()
  .max(2_000)
  .refine((value) => safeHttpsUrl(value, false), 'issuer must be a safe HTTPS URL');
const optionalUrl = endpointUrl.nullable();
const providerPatch = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    issuer: issuerUrl.optional(),
    jwksUri: endpointUrl.optional(),
    authorizationEndpoint: optionalUrl.optional(),
    tokenEndpoint: optionalUrl.optional(),
    audience: z.string().trim().min(1).max(500).optional(),
    supportsSignup: z.boolean().optional(),
    emailClaim: z.string().trim().min(1).max(200).optional(),
    tenantClaim: z.string().trim().min(1).max(200).nullable().optional(),
    subjectClaim: z.string().trim().min(1).max(200).optional(),
    browserClientId: z.string().trim().min(1).max(500).nullable().optional(),
    backchannelLogout: z.boolean().optional(),
    backchannelLogoutTypRequired: z.boolean().optional(),
    clientAuthentication: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
    clientSecret: z.string().min(1).max(4_096).optional(),
    status: z.enum(PROVIDER_STATUSES).optional(),
    reason: z.string().trim().min(3).max(2_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'reason'), {
    message: 'at least one provider field is required',
  });
const scimPolicy = z
  .object({
    enabled: z.boolean(),
    requireProvisioned: z.boolean(),
    identityAttribute: z.enum(['externalId', 'userName']),
    reason: z.string().trim().min(3).max(2_000).optional(),
  })
  .strict();

/** Builds installation-provider administration routes. */
export function adminProviderRoutes(deps: AdminRoutesDeps) {
  const routes = new Hono<{ Variables: AdminVariables }>();
  routes.get('/', async (c) => c.json({ providers: await listAdminProviders(deps.controlDb) }));
  routes.post('/:id/scim/credential', async (c) => {
    const body = await adminBody(c, scimPolicy);
    if (!body?.enabled) return c.json({ error: 'valid enabled SCIM settings are required' }, 400);
    const generated = newScimCredential();
    try {
      const provider = await configureAdminScim(deps.controlDb, {
        actorUserId: c.get('user').userId,
        providerId: c.req.param('id'),
        enabled: true,
        policy: {
          identityAttribute: body.identityAttribute,
          requireProvisioned: body.requireProvisioned,
        },
        credential: generated.credential,
        reason: body.reason,
      });
      c.header('cache-control', 'no-store');
      return c.json({ scim: scimProviderState(provider), token: generated.token });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.put('/:id/scim', async (c) => {
    const body = await adminBody(c, scimPolicy);
    if (!body) return c.json({ error: 'valid SCIM settings are required' }, 400);
    try {
      const provider = await configureAdminScim(deps.controlDb, {
        actorUserId: c.get('user').userId,
        providerId: c.req.param('id'),
        enabled: body.enabled,
        policy: {
          identityAttribute: body.identityAttribute,
          requireProvisioned: body.requireProvisioned,
        },
        reason: body.reason,
      });
      return c.json({ scim: scimProviderState(provider) });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.get('/:id/scim/accounts', async (c) => {
    const [provider] = await deps.controlDb
      .select({ id: identityProviders.id })
      .from(identityProviders)
      .where(
        and(
          eq(identityProviders.id, c.req.param('id')),
          eq(identityProviders.scope, 'installation'),
        ),
      )
      .limit(1);
    if (!provider) return c.json({ error: 'installation provider not found' }, 404);
    const startIndex = Number(c.req.query('startIndex') ?? 1);
    const count = Number(c.req.query('count') ?? 50);
    if (
      !Number.isInteger(startIndex) ||
      startIndex < 1 ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 200
    ) {
      return c.json({ error: 'valid pagination is required' }, 400);
    }
    return c.json(await listDirectoryAccounts(deps.controlDb, provider.id, { startIndex, count }));
  });
  routes.put('/:id', async (c) => {
    const body = await adminBody(c, providerPatch);
    if (!body) return c.json({ error: 'valid provider changes are required' }, 400);
    const { reason, clientSecret, ...patch } = body;
    try {
      const [current] = await deps.controlDb
        .select()
        .from(identityProviders)
        .where(
          and(
            eq(identityProviders.id, c.req.param('id')),
            eq(identityProviders.scope, 'installation'),
          ),
        )
        .limit(1);
      if (!current) return c.json({ error: 'installation provider not found' }, 404);
      const browserClientId = Object.prototype.hasOwnProperty.call(patch, 'browserClientId')
        ? patch.browserClientId
        : current.browserClientId;
      const backchannelLogout = patch.backchannelLogout ?? current.backchannelLogout;
      if (backchannelLogout && (current.kind !== 'oidc' || !browserClientId)) {
        return c.json({ error: 'A browser client ID is required for back-channel logout.' }, 400);
      }
      const authentication = patch.clientAuthentication ?? current.clientAuthentication;
      if (authentication !== 'none') {
        if (!deps.clientSecrets)
          return c.json({ error: 'Client secret storage is unavailable.' }, 503);
        if (!clientSecret && !(await deps.clientSecrets.get(`oidc-client:${current.id}`)))
          return c.json({ error: 'Enter a client secret for this web application.' }, 400);
      }
      if (clientSecret) {
        if (!deps.clientSecrets)
          return c.json({ error: 'Client secret storage is unavailable.' }, 503);
        await deps.clientSecrets.put(`oidc-client:${current.id}`, clientSecret);
      }
      const provider = await updateAdminProvider(deps.controlDb, {
        actorUserId: c.get('user').userId,
        providerId: c.req.param('id'),
        patch,
        reason,
      });
      deps.auth.verifiers.invalidate();
      return c.json({ provider });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  return routes;
}
