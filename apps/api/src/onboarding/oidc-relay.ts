import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { fetchPinnedHttps } from '@sre/connectors';
import type { JsonFetcher } from './oidc-discovery';

const REMOTE_TIMEOUT_MS = 5_000;
const REMOTE_MAX_BYTES = 64 * 1024;
const TOKEN_ERROR_MESSAGES = new Map([
  ['invalid_request', 'provider rejected the token request'],
  ['invalid_client', 'provider rejected the application credentials'],
  ['invalid_grant', 'provider rejected the authorization grant'],
  ['unauthorized_client', 'provider does not allow this client grant'],
  ['unsupported_grant_type', 'provider does not support this grant type'],
  ['invalid_scope', 'provider rejected the requested scope'],
]);

export type FormPoster = (
  url: URL,
  form: Record<string, string>,
  headers?: Record<string, string>,
) => Promise<unknown>;

/** Fetches bounded JSON through a fresh resolve-validate-pin HTTPS request. */
export async function fetchGuardedJson(
  url: URL,
  options: { timeoutMs: number; maxResponseBytes: number; redirect: 'error' },
): Promise<unknown> {
  const response = await fetchPinnedHttps(url, {
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
  });
  if (!response.ok) throw new Error(`OIDC provider returned HTTP ${response.status}`);
  return response.json();
}

/** Posts one authorization grant through a fresh pinned HTTPS connection. */
export async function postGuardedForm(
  url: URL,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetchPinnedHttps(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    timeoutMs: REMOTE_TIMEOUT_MS,
    maxResponseBytes: REMOTE_MAX_BYTES,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const code = typeof body?.error === 'string' ? body.error : '';
    const message = TOKEN_ERROR_MESSAGES.get(code);
    if (message) throw new OidcCompletionError(code, message);
    throw new OidcCompletionError('exchange_failed', 'provider token exchange failed');
  }
  return response.json();
}

/** Represents an exchange or token-verification failure safe to expose to the caller. */
export class OidcCompletionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OidcCompletionError';
  }
}

/** Loads one provider's persisted JWKS document through the guarded JSON client. */
export async function loadProviderJwks(
  provider: { id: string; jwksUri: string },
  dependencies: { fetchJson: JsonFetcher },
): Promise<JWTVerifyGetKey> {
  const value = await dependencies.fetchJson(new URL(provider.jwksUri), {
    maxResponseBytes: REMOTE_MAX_BYTES,
    redirect: 'error',
    timeoutMs: REMOTE_TIMEOUT_MS,
  });
  const document = value as { keys?: unknown } | null;
  if (!document || !Array.isArray(document.keys)) {
    throw new OidcCompletionError('invalid_jwks', 'provider JWKS document is invalid');
  }
  return createLocalJWKSet(document as JSONWebKeySet);
}
