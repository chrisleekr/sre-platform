import { assertSafeHttpsUrl, type HostLookup } from '@sre/connectors';
import { GITLAB_MANAGED_HOOK_EVENTS } from '@sre/contracts';

export interface ManagementCredential {
  accessToken: string;
  destination: string;
  webhookSecret?: string;
  signingToken?: string;
}

export class ManagementFailure extends Error {
  constructor(readonly category: string) {
    super(category);
    this.name = 'ManagementFailure';
  }
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function providerId(value: unknown): string {
  const id = String(value ?? '');
  if (!/^[1-9]\d*$/.test(id) || (typeof value === 'number' && !Number.isSafeInteger(value)))
    throw new ManagementFailure('invalid_provider_identity');
  return id;
}

export function marker(id: string): string {
  return `sre-platform:managed-hook:${id}`;
}

export function inGroup(path: unknown, group: string): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith(`${group}/`) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

/**
 * Create a bounded transport for one administrator-approved GitLab instance.
 * @param baseUrl - Saved instance URL, revalidated before credentials are sent.
 * @param credential - Isolated management token and encrypted delivery material.
 * @param fetchImpl - HTTP transport; redirects are forbidden.
 * @param lookup - DNS resolver enforcing the connector network policy.
 */
export async function managementClient(
  baseUrl: string,
  credential: ManagementCredential,
  fetchImpl: typeof fetch,
  lookup?: HostLookup,
) {
  const base = await assertSafeHttpsUrl(baseUrl, lookup, { allowPrivate: true });
  const destination = new URL(credential.destination);
  if (
    destination.protocol !== 'https:' ||
    destination.username ||
    destination.password ||
    destination.hash
  )
    throw new ManagementFailure('invalid_destination');
  if (
    typeof credential.accessToken !== 'string' ||
    !credential.accessToken ||
    (!credential.webhookSecret && !credential.signingToken)
  )
    throw new ManagementFailure('missing_management_credential');
  let calls = 0;
  async function request(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown) {
    if (++calls > 6) throw new ManagementFailure('request_budget_exhausted');
    const response = await fetchImpl(
      `${base.origin}${base.pathname.replace(/\/+$/, '')}/api/v4${path}`,
      {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { 'PRIVATE-TOKEN': credential.accessToken, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ManagementFailure(
        response.status === 429
          ? 'rate_limited'
          : [401, 403].includes(response.status)
            ? 'permission_denied'
            : response.status === 404
              ? 'not_found'
              : 'provider_unavailable',
      );
    }
    const reader = response.body?.getReader();
    let size = 0,
      text = '';
    const decoder = new TextDecoder();
    if (reader)
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new ManagementFailure('response_too_large');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    const value: unknown = JSON.parse(text + decoder.decode());
    return { value, next: response.headers.get('x-next-page') };
  }
  async function page(path: string, pageNumber: number) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1)
      throw new ManagementFailure('invalid_cursor');
    const response = await request(
      `${path}${path.includes('?') ? '&' : '?'}per_page=20&page=${pageNumber}`,
    );
    if (!Array.isArray(response.value) || response.value.length > 20)
      throw new ManagementFailure('invalid_provider_page');
    return {
      values: response.value.map(object),
      more: response.next === null ? response.value.length === 20 : response.next !== '',
    };
  }
  const desired = (ownershipId: string) => ({
    ...GITLAB_MANAGED_HOOK_EVENTS,
    name: 'SRE Platform',
    description: marker(ownershipId),
    url: credential.destination,
    enable_ssl_verification: true,
    branch_filter_strategy: 'all_branches',
    push_events_branch_filter: '',
    ...(credential.webhookSecret ? { token: credential.webhookSecret } : {}),
    ...(credential.signingToken ? { signing_token: credential.signingToken } : {}),
  });
  return {
    group: async (id: string) => object((await request(`/groups/${providerId(id)}`)).value),
    catalog: (id: string, n: number) =>
      page(
        `/groups/${providerId(id)}/projects?include_subgroups=true&with_shared=false&order_by=id&sort=asc`,
        n,
      ),
    project: async (id: string) => object((await request(`/projects/${providerId(id)}`)).value),
    hooks: (id: string, n: number) => page(`/projects/${providerId(id)}/hooks`, n),
    hook: async (projectId: string, id: string) =>
      object((await request(`/projects/${providerId(projectId)}/hooks/${providerId(id)}`)).value),
    create: async (projectId: string, ownershipId: string) =>
      object(
        (await request(`/projects/${providerId(projectId)}/hooks`, 'POST', desired(ownershipId)))
          .value,
      ),
    update: async (projectId: string, id: string, ownershipId: string) =>
      object(
        (
          await request(
            `/projects/${providerId(projectId)}/hooks/${providerId(id)}`,
            'PUT',
            desired(ownershipId),
          )
        ).value,
      ),
  };
}
