import type { CredentialGetter } from './request-credentials';
import { config } from '../config';
import { authenticatedFetch } from './authenticatedFetch';
import { checkResponse } from './request-error';

export interface WorkspaceMethod {
  id: string;
  displayName: string;
  issuer: string;
  kind: 'oidc' | 'local';
  scope: 'installation' | 'tenant';
  status: string;
  browserClientId: string | null;
  subjectClaim: string;
  backchannelLogout: boolean;
  backchannelLogoutTypRequired: boolean;
  scimEnabled: boolean;
  scimTokenCreatedAt: string | null;
  scimTokenExpiresAt: string | null;
  requireProvisioned: boolean;
  scimIdentityAttribute: 'externalId' | 'userName';
  sortOrder: number;
  createdAt: string;
}

export interface WorkspaceDomain {
  id: string;
  providerId: string;
  domain: string;
  status: string;
  challenge: string | null;
  expiresAt: string | null;
  lastCheckedAt: string | null;
}

export interface WorkspaceSettingsData {
  workspace: {
    id: string;
    name: string;
    slug: string;
    status: string;
    requireDirectory: boolean;
    deleteAfter: string | null;
  };
  methods: WorkspaceMethod[];
  domains: WorkspaceDomain[];
}

/** Sends one authenticated workspace-settings request and surfaces actionable server copy. */
export async function workspaceSettingsRequest<T>(
  getCredentials: CredentialGetter,
  path = '',
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await authenticatedFetch(`${config.apiBaseUrl}/tenant${path}`, getCredentials, {
    method: init.method,
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  await checkResponse(response, 'Workspace request could not complete. Refresh and retry.');
  return (await response.json()) as T;
}
