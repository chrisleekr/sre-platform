import { credentialHeaders } from './request-credentials';

/** Sends API cookies and a custom header that cross-origin forms cannot supply.
 * @param input - Application API address.
 * @param init - Request options; credentials are always sent only to this explicit address.
 */
export function sessionFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-sre-session', '1');
  if (!headers.has('authorization')) {
    for (const [key, value] of Object.entries(credentialHeaders({ kind: 'cookie' })))
      headers.set(key, value);
  }
  return fetch(input, { ...init, headers: Object.fromEntries(headers), credentials: 'include' });
}
