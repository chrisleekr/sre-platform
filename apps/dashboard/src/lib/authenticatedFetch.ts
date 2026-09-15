import { reportSessionFailure, reportTokenFailure } from '../session-failure';
import { getLocalSession } from '../local-session';
import {
  getImpersonationSession,
  impersonationHeaders,
  setImpersonationSession,
} from './impersonation';
import { sessionFetch } from './session-fetch';

import {
  credentialHeaders,
  type CredentialGetter,
  type RequestCredential,
} from './request-credentials';
type AuthenticatedRequestInit = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

/**
 * Sends one API request with the active session and promotes authentication failures.
 *
 * @param input - API URL to request.
 * @param getCredentials - Explicit cookie session or genuine bearer credentials.
 * @param init - Fetch options excluding caller-controlled authorization.
 */
export async function authenticatedFetch(
  input: string,
  getCredentials: CredentialGetter,
  init: AuthenticatedRequestInit = {},
): Promise<Response> {
  let credential: RequestCredential;
  try {
    credential = await getCredentials();
  } catch (tokenError) {
    reportTokenFailure(tokenError);
    throw tokenError;
  }

  const supportHeaders = impersonationHeaders();
  const localToken =
    credential.kind === 'bearer' && getLocalSession()?.token === credential.token
      ? credential.token
      : undefined;
  const response = await sessionFetch(input, {
    ...init,
    headers: { ...init.headers, ...supportHeaders, ...credentialHeaders(credential) },
  });
  if (response.status === 403 && supportHeaders['x-impersonation-session']) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { code?: unknown } | null;
    if (
      body?.code === 'support_session_unavailable' &&
      getImpersonationSession()?.id === supportHeaders['x-impersonation-session']
    )
      setImpersonationSession(null);
  }
  if (response.status === 401 && (!localToken || getLocalSession()?.token === localToken)) {
    reportSessionFailure('unauthorized');
  }
  return response;
}
