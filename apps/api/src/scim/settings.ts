import { createHash, randomBytes } from 'node:crypto';
import type { identityProviders } from '@sre/db';

const SCIM_TOKEN_LIFETIME_MS = 180 * 24 * 60 * 60 * 1_000;

/** Creates one high-entropy SCIM bearer and its durable hash/expiry projection. */
export function newScimCredential(now = new Date()) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    credential: {
      hash: createHash('sha256').update(token).digest('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + SCIM_TOKEN_LIFETIME_MS),
    },
  };
}

/** Removes the credential hash from a provider settings response. */
export function scimProviderState(provider: typeof identityProviders.$inferSelect) {
  return {
    id: provider.id,
    scimEnabled: provider.scimEnabled,
    scimTokenCreatedAt: provider.scimTokenCreatedAt,
    scimTokenExpiresAt: provider.scimTokenExpiresAt,
    requireProvisioned: provider.requireProvisioned,
    scimIdentityAttribute: provider.scimIdentityAttribute,
  };
}
