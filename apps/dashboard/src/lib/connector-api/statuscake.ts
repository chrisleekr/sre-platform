import { checkResponse } from '../request-error';
import type { CredentialGetter } from '../request-credentials';
import { authenticatedFetch } from '../authenticatedFetch';
import { connectorMutationUrl } from './shared';

export interface StatusCakeUptimeTest {
  id: string;
  name: string;
  url?: string;
  status?: string;
  paused: boolean;
  state?: 'ready' | 'created' | 'attached' | 'repaired' | 'removed' | 'missing' | 'not_bound';
}

export interface StatusCakeSetupResponse {
  tests: StatusCakeUptimeTest[];
  changes?: number;
  error?: { category: string; message: string };
}

export async function listStatusCakeUptimeTests(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<StatusCakeSetupResponse> {
  const res = await authenticatedFetch(
    `${connectorMutationUrl(apiBaseUrl, 'statuscake', id)}/uptime-tests`,
    getCredentials,
  );
  await checkResponse(res, 'Uptime tests could not be loaded from StatusCake. Retry.');
  return (await res.json()) as StatusCakeSetupResponse;
}

export async function runStatusCakeSetup(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<StatusCakeSetupResponse> {
  const res = await authenticatedFetch(
    `${connectorMutationUrl(apiBaseUrl, 'statuscake', id)}/setup`,
    getCredentials,
    { method: 'POST' },
  );
  await checkResponse(res, 'StatusCake setup could not run. Retry.');
  return (await res.json()) as StatusCakeSetupResponse;
}
