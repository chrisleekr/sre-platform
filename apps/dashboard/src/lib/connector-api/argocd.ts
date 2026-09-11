import { checkResponse } from '../request-error';
import type { CredentialGetter } from '../request-credentials';
import type {
  ArgoCdAccessResult,
  ArgoCdApplicationScope,
  ArgoCdSettings,
  ArgoCdTestResult,
} from '../connectors';
import { authenticatedFetch } from '../authenticatedFetch';
import { connectorMutationUrl } from './shared';

export async function fetchArgoCdAccess(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: {
    project: string;
    role?: string;
    applicationsInAnyNamespace: boolean;
    applications: ArgoCdApplicationScope[];
  },
): Promise<ArgoCdAccessResult> {
  const res = await authenticatedFetch(`${apiBaseUrl}/connectors/argocd/access`, getCredentials, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await checkResponse(res, 'Access commands could not be generated. Retry.');
  return (await res.json()) as ArgoCdAccessResult;
}

export async function saveArgoCdConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: {
    id?: string;
    name: string;
    settings: ArgoCdSettings;
    credentials?: Array<{ project: string; token: string }>;
    insecureTlsAcknowledged?: boolean;
    insecureHttpAcknowledged?: boolean;
  },
): Promise<{ connectorId: string }> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'argocd', body.id),
    getCredentials,
    {
      method: body.id ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: body.name,
        settings: body.settings,
        ...(body.credentials ? { credentials: body.credentials } : {}),
        ...(body.insecureTlsAcknowledged ? { insecureTlsAcknowledged: true } : {}),
        ...(body.insecureHttpAcknowledged ? { insecureHttpAcknowledged: true } : {}),
      }),
    },
  );
  await checkResponse(res, 'The connection could not be saved. Review its status and retry.');
  return (await res.json()) as { connectorId: string };
}

export async function testArgoCdConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<ArgoCdTestResult> {
  const res = await authenticatedFetch(
    `${connectorMutationUrl(apiBaseUrl, 'argocd', id)}/test`,
    getCredentials,
    { method: 'POST' },
  );
  await checkResponse(res, 'Verification could not complete. Refresh the connection and retry.');
  return (await res.json()) as ArgoCdTestResult;
}

export async function disconnectArgoCdConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<void> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'argocd', id),
    getCredentials,
    {
      method: 'DELETE',
    },
  );
  await checkResponse(
    res,
    'Disconnect could not be confirmed. Refresh the connection before retrying.',
  );
}
