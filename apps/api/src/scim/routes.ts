import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PublicRateLimiter } from '../onboarding/contracts';
import type { RevokePublisher } from '../auth/revoke';
import type { Logger } from '../logger';
import {
  createDirectoryAccount,
  deleteDirectoryAccount,
  getDirectoryAccount,
  listDirectoryAccounts,
  replaceDirectoryAccount,
  type Db,
  type DirectoryAccountInput,
} from '@sre/db';
import { scimAuthentication, type ScimVariables } from './auth';
import {
  SCIM_CONTENT_TYPE,
  SCIM_MAX_BODY_BYTES,
  SCIM_MAX_PAGE,
  SCIM_USER_SCHEMA,
} from './constants';
import { scimError } from './errors';
import { parseScimFilter } from './filter';
import { applyScimPatch, parseScimUser } from './input';
import {
  scimList,
  scimUser,
  serviceProviderConfig,
  userResourceType,
  userSchema,
} from './representation';

const BASE = '/scim/v2/providers/:providerId';
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATE_LIMIT = 1_200;
const RATE_WINDOW_MS = 60_000;

export interface ScimRoutesDeps {
  db: Db;
  revoke: RevokePublisher;
  limiter?: PublicRateLimiter;
  sourceAddress?: (context: Context) => string;
  log?: Pick<Logger, 'error'>;
}

function providerBase(c: Context<{ Variables: ScimVariables }>): string {
  return `${new URL(c.req.url).origin}/scim/v2/providers/${c.get('scimProvider').id}`;
}

function scimJson(c: Context, value: object, status: 200 | 201 = 200) {
  return c.body(JSON.stringify(value), status, {
    'Content-Type': SCIM_CONTENT_TYPE,
    'Cache-Control': 'no-store',
  });
}

function mediaType(c: Context): boolean {
  return c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === SCIM_CONTENT_TYPE;
}

async function requestJson(c: Context): Promise<unknown | undefined> {
  if (!mediaType(c)) return undefined;
  return c.req.json().catch(() => undefined);
}

function currentInput(
  account: Awaited<ReturnType<typeof getDirectoryAccount>>,
): DirectoryAccountInput {
  if (!account) throw new Error('current directory account required');
  return {
    externalId: account.externalId,
    userName: account.userName,
    active: account.active,
    name: account.name,
    emails: account.emails,
  };
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

async function publishRevocations(revoke: RevokePublisher, userIds: string[]) {
  await Promise.allSettled(userIds.map((userId) => revoke.publish({ userId })));
}

function pageValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

/** Builds the provider-authenticated RFC 7643/7644 SCIM User service. */
export function scimRoutes(deps: ScimRoutesDeps) {
  const routes = new Hono<{ Variables: ScimVariables }>();
  routes.onError((error, c) => {
    deps.log?.error('SCIM request failed', {
      path: c.req.path,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return scimError(c, 503, 'Provisioning service is temporarily unavailable.');
  });
  routes.use(`${BASE}/*`, async (c, next) => {
    if (!deps.limiter || !deps.sourceAddress) return next();
    try {
      if (!(await deps.limiter.allow('scim', deps.sourceAddress(c), RATE_LIMIT, RATE_WINDOW_MS))) {
        c.header('Retry-After', '60');
        return scimError(c, 429, 'Too many provisioning requests.');
      }
    } catch {
      return scimError(c, 503, 'Provisioning authentication is temporarily unavailable.');
    }
    await next();
  });
  routes.use(`${BASE}/*`, scimAuthentication(deps.db));
  routes.use(
    `${BASE}/*`,
    bodyLimit({
      maxSize: SCIM_MAX_BODY_BYTES,
      onError: (c) => scimError(c, 413, 'Request body is too large.'),
    }),
  );

  routes.get(`${BASE}/ServiceProviderConfig`, (c) => scimJson(c, serviceProviderConfig));
  routes.get(`${BASE}/ResourceTypes`, (c) => scimJson(c, scimList([userResourceType], 1, 1)));
  routes.get(`${BASE}/Schemas`, (c) => scimJson(c, scimList([userSchema], 1, 1)));
  routes.get(`${BASE}/Schemas/:schemaId`, (c) =>
    c.req.param('schemaId').toLowerCase() === SCIM_USER_SCHEMA.toLowerCase()
      ? scimJson(c, userSchema)
      : scimError(c, 404, 'Schema not found.'),
  );
  routes.get(`${BASE}/ResourceTypes/:resourceType`, (c) =>
    c.req.param('resourceType').toLowerCase() === 'user'
      ? scimJson(c, userResourceType)
      : scimError(c, 404, 'Resource type not found.'),
  );

  routes.get(`${BASE}/Users`, async (c) => {
    const startIndex = pageValue(c.req.query('startIndex'), 1, 1, Number.MAX_SAFE_INTEGER);
    const count = pageValue(c.req.query('count'), 100, 0, SCIM_MAX_PAGE);
    if (startIndex === null || count === null) {
      return scimError(c, 400, 'Pagination is invalid.', 'invalidValue');
    }
    const filter = parseScimFilter(c.req.query('filter'));
    if (filter === false) return scimError(c, 400, 'Filter is not supported.', 'invalidFilter');
    const providerId = c.get('scimProvider').id;
    const result = await listDirectoryAccounts(deps.db, providerId, {
      startIndex,
      count,
      ...(filter ? { filter } : {}),
    });
    const baseUrl = providerBase(c);
    return scimJson(
      c,
      scimList(
        result.accounts.map((account) => scimUser(account, baseUrl)),
        result.total,
        startIndex,
      ),
    );
  });

  routes.get(`${BASE}/Users/:accountId`, async (c) => {
    if (!RESOURCE_ID.test(c.req.param('accountId'))) {
      return scimError(c, 404, 'User not found.');
    }
    const account = await getDirectoryAccount(
      deps.db,
      c.get('scimProvider').id,
      c.req.param('accountId'),
    );
    return account
      ? scimJson(c, scimUser(account, providerBase(c)))
      : scimError(c, 404, 'User not found.');
  });

  routes.post(`${BASE}/Users`, async (c) => {
    const input = parseScimUser(await requestJson(c));
    if (!input) return scimError(c, 400, 'User representation is invalid.', 'invalidValue');
    try {
      const account = await createDirectoryAccount(deps.db, c.get('scimProvider').id, input);
      c.header('Location', `${providerBase(c)}/Users/${account.id}`);
      return scimJson(c, scimUser(account, providerBase(c)), 201);
    } catch (error) {
      if (uniqueViolation(error)) {
        return scimError(c, 409, 'userName or externalId already exists.', 'uniqueness');
      }
      throw error;
    }
  });

  routes.put(`${BASE}/Users/:accountId`, async (c) => {
    if (!RESOURCE_ID.test(c.req.param('accountId'))) return scimError(c, 404, 'User not found.');
    const input = parseScimUser(await requestJson(c));
    if (!input) return scimError(c, 400, 'User representation is invalid.', 'invalidValue');
    try {
      const result = await replaceDirectoryAccount(
        deps.db,
        c.get('scimProvider').id,
        c.req.param('accountId'),
        input,
      );
      if (!result) return scimError(c, 404, 'User not found.');
      await publishRevocations(deps.revoke, result.revokedUserIds);
      return scimJson(c, scimUser(result.account, providerBase(c)));
    } catch (error) {
      if (uniqueViolation(error)) {
        return scimError(c, 409, 'userName or externalId already exists.', 'uniqueness');
      }
      throw error;
    }
  });

  routes.patch(`${BASE}/Users/:accountId`, async (c) => {
    if (!RESOURCE_ID.test(c.req.param('accountId'))) return scimError(c, 404, 'User not found.');
    const providerId = c.get('scimProvider').id;
    const current = await getDirectoryAccount(deps.db, providerId, c.req.param('accountId'));
    if (!current) return scimError(c, 404, 'User not found.');
    const patched = applyScimPatch(currentInput(current), await requestJson(c));
    if ('error' in patched) {
      return scimError(c, 400, 'Patch operation is invalid.', patched.error);
    }
    try {
      const result = await replaceDirectoryAccount(deps.db, providerId, current.id, patched.value);
      if (!result) return scimError(c, 404, 'User not found.');
      await publishRevocations(deps.revoke, result.revokedUserIds);
      return scimJson(c, scimUser(result.account, providerBase(c)));
    } catch (error) {
      if (uniqueViolation(error)) {
        return scimError(c, 409, 'userName or externalId already exists.', 'uniqueness');
      }
      throw error;
    }
  });

  routes.delete(`${BASE}/Users/:accountId`, async (c) => {
    if (!RESOURCE_ID.test(c.req.param('accountId'))) return scimError(c, 404, 'User not found.');
    const result = await deleteDirectoryAccount(
      deps.db,
      c.get('scimProvider').id,
      c.req.param('accountId'),
    );
    if (!result) return scimError(c, 404, 'User not found.');
    await publishRevocations(deps.revoke, result.revokedUserIds);
    c.header('Cache-Control', 'no-store');
    return c.body(null, 204);
  });

  routes.all(`${BASE}/*`, (c) => scimError(c, 404, 'SCIM endpoint not found.'));
  return routes;
}
