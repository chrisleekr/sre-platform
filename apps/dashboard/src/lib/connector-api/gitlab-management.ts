import { authenticatedFetch } from '../authenticatedFetch';
import { checkResponse } from '../request-error';
import type { CredentialGetter } from '../request-credentials';

export interface GitLabManagementStatus {
  authorized: boolean;
  approvedAt: string | null;
  catalogCheckedAt: string | null;
  failureCategory: string | null;
  counts: { total: number; covered: number; missing: number; failed: number; pending: number };
  projects: Array<{
    project: string;
    hookId: string | null;
    failureCategory: string | null;
    lastCheckedAt: string | null;
  }>;
}
export interface GitLabManagementPreview {
  reviewDigest: string;
  scope: { baseUrl: string; groupPath: string; events: Record<string, boolean> };
  receiver: string;
  knownProjects: number;
  projects: Array<{
    project: string;
    recordedHookId: string | null;
    action: 'recover' | 'verify_or_update' | 'inspect_or_create';
    recovery?: { recordId: string; ownershipId: string; attemptedAt: string };
  }>;
  effect: string;
}

/**
 * Build the administrative API boundary separately from read-only connector configuration.
 * @param baseUrl - Configured platform API address.
 * @param credentials - Current authenticated workspace credentials.
 */
export function gitLabManagementApi(baseUrl: string, credentials: CredentialGetter) {
  async function request<T>(id: string, action?: string, body?: unknown): Promise<T> {
    const response = await authenticatedFetch(
      `${baseUrl}/connectors/gitlab/${encodeURIComponent(id)}/management${action ? `/${action}` : ''}`,
      credentials,
      {
        method: action ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        ...(action ? { body: JSON.stringify(body ?? {}) } : {}),
      },
    );
    await checkResponse(response, 'Webhook management request failed. Refresh and retry.');
    return (await response.json()) as T;
  }
  return {
    status: (id: string) => request<GitLabManagementStatus>(id),
    preview: (id: string, destination: string) =>
      request<GitLabManagementPreview>(id, 'preview', { destination }),
    authorize: (
      id: string,
      body: {
        destination: string;
        reviewDigest: string;
        managementToken: string;
        approved: true;
        recoveries?: Array<{ recordId: string; attemptedAt: string; confirmedAbsent: true }>;
      },
    ) => request(id, 'authorize', body),
    revoke: (id: string) => request(id, 'revoke'),
  };
}
export type GitLabManagementApi = ReturnType<typeof gitLabManagementApi>;
