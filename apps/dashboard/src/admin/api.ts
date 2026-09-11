import type { CredentialGetter } from '../lib/request-credentials';
import { config } from '../config';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { checkResponse } from '../lib/request-error';

/** Sends one administrator request and surfaces the server's actionable error. */
export async function adminRequest<T>(
  getCredentials: CredentialGetter,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await authenticatedFetch(`${config.apiBaseUrl}/admin${path}`, getCredentials, {
    method: init.method,
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  await checkResponse(response, 'Administrator request could not complete. Refresh and retry.');
  return (await response.json()) as T;
}
