import { checkResponse, RequestError } from '../request-error';
import { GITLAB_DISCOVERY_ERRORS } from './discovery-errors';
import type { CredentialGetter } from '../request-credentials';
import type { GitLabDiscovery, GitLabSettings, GitLabTestResult } from '../connectors';
import { authenticatedFetch } from '../authenticatedFetch';
import { connectorMutationUrl } from './shared';

export class GitLabDiscoveryRequestError extends Error {}

export async function discoverGitLabProjects(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: { dataSourceId?: string; baseUrl: string; groupPath: string; credential?: string },
): Promise<GitLabDiscovery> {
  const res = await authenticatedFetch(`${apiBaseUrl}/connectors/gitlab/projects`, getCredentials, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(body.dataSourceId ? { dataSourceId: body.dataSourceId } : {}),
      settings: { baseUrl: body.baseUrl, groupPath: body.groupPath },
      ...(body.credential ? { credential: body.credential } : {}),
    }),
  });
  if (!res.ok) {
    try {
      await checkResponse(
        res,
        'Discovery could not complete. Check your connection and retry.',
        GITLAB_DISCOVERY_ERRORS,
      );
    } catch (cause) {
      if (cause instanceof RequestError)
        throw new GitLabDiscoveryRequestError(cause.message, { cause });
      throw cause;
    }
  }
  return (await res.json()) as GitLabDiscovery;
}

export async function saveGitLabConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: {
    id?: string;
    setupId?: string;
    name: string;
    settings: GitLabSettings;
    issueCredential?: string;
    credential?: string;
    webhookSecret?: string;
    webhookSigningToken?: string;
  },
): Promise<{
  connectorId: string;
  name: string;
  webhookPath?: string;
  relayStatus?: 'connected' | 'stopped' | 'failed';
}> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'gitlab', body.id),
    getCredentials,
    {
      method: body.id ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: body.name,
        ...(body.setupId ? { setupId: body.setupId } : {}),
        settings: body.settings,
        ...(body.issueCredential ? { issueCredential: body.issueCredential } : {}),
        ...(body.credential ? { credential: body.credential } : {}),
        ...(body.webhookSecret ? { webhookSecret: body.webhookSecret } : {}),
        ...(body.webhookSigningToken ? { webhookSigningToken: body.webhookSigningToken } : {}),
        enabled: false,
      }),
    },
  );
  await checkResponse(res, 'The connection could not be saved. Review its status and retry.');
  return (await res.json()) as {
    connectorId: string;
    name: string;
    webhookPath?: string;
    relayStatus?: 'connected' | 'stopped' | 'failed';
  };
}

export async function testGitLabConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<GitLabTestResult> {
  const res = await authenticatedFetch(
    `${connectorMutationUrl(apiBaseUrl, 'gitlab', id)}/test`,
    getCredentials,
    { method: 'POST' },
  );
  await checkResponse(res, 'Verification could not complete. Refresh the connection and retry.');
  return (await res.json()) as GitLabTestResult;
}

export async function disconnectGitLabConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<void> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'gitlab', id),
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
