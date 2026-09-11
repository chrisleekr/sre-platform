import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getScimProvider, type Db } from '@sre/db';
import { scimError } from './errors';

const PROVIDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;

export interface ScimProviderContext {
  id: string;
}

export interface ScimVariables {
  scimProvider: ScimProviderContext;
}

function matchesHash(value: string, expected: string): boolean {
  const actual = Buffer.from(createHash('sha256').update(value).digest('hex'), 'hex');
  const stored = Buffer.from(expected, 'hex');
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}

/** Authenticates one provider-scoped SCIM request with its expiring bearer credential. */
export function scimAuthentication(db: Db) {
  return async (c: Context<{ Variables: ScimVariables }>, next: Next) => {
    const providerId = c.req.param('providerId') ?? '';
    const authorization = c.req.header('authorization');
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
    if (!PROVIDER_ID.test(providerId) || !match || !TOKEN.test(match[1]!)) {
      return scimError(c, 401, 'Authentication is required.');
    }
    const provider = await getScimProvider(db, providerId);
    if (
      !provider ||
      provider.status !== 'active' ||
      provider.kind !== 'oidc' ||
      !provider.browserClientId ||
      !provider.scimEnabled ||
      !provider.scimTokenHash ||
      !provider.scimTokenExpiresAt ||
      provider.scimTokenExpiresAt.getTime() <= Date.now() ||
      !matchesHash(match[1]!, provider.scimTokenHash)
    ) {
      return scimError(c, 401, 'Authentication is required.');
    }
    c.set('scimProvider', { id: provider.id });
    await next();
  };
}
