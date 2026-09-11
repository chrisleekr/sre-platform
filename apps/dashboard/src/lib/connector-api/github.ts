import { checkResponse } from '../request-error';
import { GITHUB_DISCOVERY_ERRORS } from './discovery-errors';
import type { CredentialGetter } from '../request-credentials';
import type {
  GitHubInstallationSummary,
  GitHubRepositorySummary,
  GitHubSettings,
  GitHubTestResult,
} from '../connectors';
import { authenticatedFetch } from '../authenticatedFetch';
import { connectorMutationUrl } from './shared';

export async function discoverGitHubInstallations(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: { dataSourceId?: string; appId: string; credential?: string },
): Promise<GitHubInstallationSummary[]> {
  const res = await authenticatedFetch(
    `${apiBaseUrl}/connectors/github/installations`,
    getCredentials,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(body.dataSourceId ? { dataSourceId: body.dataSourceId } : {}),
        settings: { appId: body.appId },
        ...(body.credential ? { credential: body.credential } : {}),
      }),
    },
  );
  await checkResponse(
    res,
    'GitHub installation discovery failed. Check the App installation and key.',
    GITHUB_DISCOVERY_ERRORS,
  );
  return ((await res.json()) as { installations: GitHubInstallationSummary[] }).installations;
}

export async function discoverGitHubRepositories(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: {
    dataSourceId?: string;
    appId: string;
    installationId: string | number;
    credential?: string;
  },
): Promise<GitHubRepositorySummary[]> {
  const res = await authenticatedFetch(
    `${apiBaseUrl}/connectors/github/repositories`,
    getCredentials,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(body.dataSourceId ? { dataSourceId: body.dataSourceId } : {}),
        settings: { appId: body.appId, installationId: body.installationId },
        ...(body.credential ? { credential: body.credential } : {}),
      }),
    },
  );
  await checkResponse(res, 'Repositories could not be discovered. Retry.');
  return ((await res.json()) as { repositories: GitHubRepositorySummary[] }).repositories;
}

export async function saveGitHubConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: {
    id?: string;
    setupId?: string;
    name: string;
    settings: GitHubSettings;
    credential?: string;
    webhookSecret?: string;
  },
): Promise<{
  connectorId: string;
  name: string;
  webhookPath?: string;
  relayStatus?: 'connected' | 'stopped' | 'failed';
}> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'github', body.id),
    getCredentials,
    {
      method: body.id ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: body.name,
        ...(body.setupId ? { setupId: body.setupId } : {}),
        settings: body.settings,
        ...(body.credential ? { credential: body.credential } : {}),
        ...(body.webhookSecret ? { webhookSecret: body.webhookSecret } : {}),
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

export interface GitHubManifestStart {
  actionUrl: string;
  state: string;
  manifest: Record<string, unknown>;
  webhookUrl: string;
  localWebhookPath: string;
  expiresAt: string;
}

export async function startGitHubManifest(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: {
    name: string;
    setupId?: string;
    ownerType: 'personal' | 'organization';
    organization?: string;
    deliveryMode: 'direct' | 'smee';
    deliveryUrl: string;
    dashboardUrl: string;
  },
): Promise<GitHubManifestStart> {
  const res = await authenticatedFetch(
    `${apiBaseUrl}/connectors/github/manifest/start`,
    getCredentials,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  await checkResponse(res, 'GitHub App setup failed');
  return (await res.json()) as GitHubManifestStart;
}

export interface GitHubManifestComplete {
  connectorId: string;
  name: string;
  appId: string;
  appSlug: string;
  appUrl: string;
  installUrl: string;
  eventTransport: 'direct' | 'smee';
  localWebhookPath: string;
  relayStatus?: 'connected' | 'stopped' | 'failed';
}

export async function completeGitHubManifest(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: { code: string; state: string },
): Promise<GitHubManifestComplete> {
  const res = await authenticatedFetch(
    `${apiBaseUrl}/connectors/github/manifest/complete`,
    getCredentials,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  await checkResponse(res, 'GitHub App setup completion failed');
  return (await res.json()) as GitHubManifestComplete;
}

export async function testGitHubConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<GitHubTestResult> {
  const res = await authenticatedFetch(
    `${connectorMutationUrl(apiBaseUrl, 'github', id)}/test`,
    getCredentials,
    { method: 'POST' },
  );
  await checkResponse(res, 'Verification could not complete. Refresh the connection and retry.');
  return (await res.json()) as GitHubTestResult;
}

export async function disconnectGitHubConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<void> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'github', id),
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
