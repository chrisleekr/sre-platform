import type { ConnectorConfig } from '../../registry';
import { obj, str } from '../../values';
import {
  ArgoApiError,
  ArgoPermissionError,
  MAX_APPLICATIONS,
  PROBE_JSON_BYTES,
  aInit,
  aget,
  boundedJson,
  checkedJsonGet,
  configuredScopes,
  isTlsFailure,
  type ApplicationScope,
  type ArgoClient,
  type FetchLike,
  type QueryValue,
} from './client';
import { matchesScope, stringArray } from './projection';

export function applicationListQuery(
  settings: Record<string, unknown>,
): Record<string, QueryValue | undefined> {
  const scopes = configuredScopes(settings);
  const projects = [...new Set(scopes.map((scope) => scope.project))];
  const selector = str(settings.labelSelector);
  return {
    // Argo CD stores an omitted project as an empty string but treats it as `default`. Its list-side
    // project filter compares the raw value, so local filtering is required for a default scope.
    projects:
      projects.length > 0 && !projects.includes('*') && !projects.includes('default')
        ? projects
        : undefined,
    selector,
  };
}

export async function readApplications(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  client: ArgoClient,
  limit = MAX_APPLICATIONS,
): Promise<unknown[]> {
  const body = await checkedJsonGet(
    fetchImpl,
    client,
    '/api/v1/applications',
    applicationListQuery(config.settings),
  );
  const rawItems = obj(body).items;
  const items = rawItems === null ? [] : rawItems;
  if (!Array.isArray(items))
    throw new ArgoApiError('argocd Applications response is malformed', 'provider_unavailable');
  if (items.length > limit)
    throw new ArgoApiError('argocd application count exceeds bound', 'backlog');
  const scopes = configuredScopes(config.settings);
  return items.filter((application) =>
    matchesScope(application, scopes, config.settings.applicationsInAnyNamespace === true),
  );
}

export async function readScopedApplication(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  client: ArgoClient,
  name: string,
  appNamespace?: string,
): Promise<unknown> {
  const anyNamespace = config.settings.applicationsInAnyNamespace === true;
  if (anyNamespace && !appNamespace)
    throw new ArgoApiError(
      'application namespace is required for Applications-in-any-namespace',
      'permission_denied',
    );
  if (!anyNamespace && appNamespace)
    throw new ArgoApiError(
      'application namespace is outside the configured scope',
      'permission_denied',
    );
  const application = await aget(
    fetchImpl,
    client,
    `/api/v1/applications/${encodeURIComponent(name)}`,
    { appNamespace },
  );
  const metadata = obj(obj(application).metadata);
  if (
    str(metadata.name) !== name ||
    (appNamespace && str(metadata.namespace) !== appNamespace) ||
    !matchesScope(application, configuredScopes(config.settings), anyNamespace)
  )
    throw new ArgoApiError('application is outside the configured scope', 'permission_denied');
  return application;
}

export function applicationScopeObject(scope: ApplicationScope, anyNamespace: boolean): string {
  return anyNamespace
    ? `${scope.project}/${scope.namespace}/${scope.name}`
    : `${scope.project}/${scope.name}`;
}

export function scopeMatchesParts(
  scope: ApplicationScope,
  anyNamespace: boolean,
  project: string,
  namespace: string,
  name: string,
): boolean {
  return (
    (scope.project === '*' || scope.project === project) &&
    (scope.name === '*' || scope.name === name) &&
    (!anyNamespace || scope.namespace === '*' || scope.namespace === namespace)
  );
}

export function outsideApplicationObject(
  scopes: ApplicationScope[],
  anyNamespace: boolean,
): string | null {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const project = `sre-platform-outside-${attempt}`;
    const namespace = `sre-platform-outside-${attempt}`;
    const name = `sre-platform-outside-${attempt}`;
    if (!scopes.some((scope) => scopeMatchesParts(scope, anyNamespace, project, namespace, name)))
      return anyNamespace ? `${project}/${namespace}/${name}` : `${project}/${name}`;
  }
  return null;
}

type ArgoResource =
  | 'accounts'
  | 'applications'
  | 'applicationsets'
  | 'certificates'
  | 'clusters'
  | 'exec'
  | 'extensions'
  | 'gpgkeys'
  | 'logs'
  | 'projects'
  | 'repositories'
  | 'write-repositories';

type ArgoAction =
  'action' | 'create' | 'delete' | 'get' | 'invoke' | 'override' | 'sync' | 'update';

interface PermissionCheck {
  resource: ArgoResource;
  action: ArgoAction;
  object: string;
}

export async function canI(
  fetchImpl: FetchLike,
  client: ArgoClient,
  resource: ArgoResource,
  action: ArgoAction,
  subresource: string,
): Promise<boolean> {
  const url = `${client.base.replace(/\/+$/, '')}/api/v1/account/can-i/${resource}/${action}/${encodeURIComponent(subresource)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, aInit(client));
  } catch (error) {
    const tls = isTlsFailure(error);
    throw new ArgoApiError(
      tls ? 'argocd TLS verification failed' : 'argocd did not respond',
      tls ? 'tls' : 'unreachable',
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new ArgoApiError('argocd permission preflight was denied', 'permission_denied');
  if (!response.ok)
    throw new ArgoApiError('argocd permission preflight failed', 'provider_unavailable');
  const value = str(obj(await boundedJson(response, PROBE_JSON_BYTES)).value);
  if (value !== 'yes' && value !== 'no')
    throw new ArgoApiError('argocd permission preflight was malformed', 'provider_unavailable');
  return value === 'yes';
}

export async function runPermissionChecks(
  fetchImpl: FetchLike,
  client: ArgoClient,
  checks: PermissionCheck[],
): Promise<boolean[]> {
  const results: boolean[] = [];
  for (let offset = 0; offset < checks.length; offset += 8) {
    const batch = checks.slice(offset, offset + 8);
    results.push(
      ...(await Promise.all(
        batch.map((check) => canI(fetchImpl, client, check.resource, check.action, check.object)),
      )),
    );
  }
  return results;
}

export async function verifyDedicatedAccount(
  expectedAccount: string,
  fetchImpl: FetchLike,
  client: ArgoClient,
): Promise<void> {
  const account = obj(
    await checkedJsonGet(
      fetchImpl,
      client,
      `/api/v1/account/${encodeURIComponent(expectedAccount)}`,
      undefined,
      PROBE_JSON_BYTES,
    ),
  );
  const capabilities = stringArray(account.capabilities).sort();
  if (
    str(account.name) !== expectedAccount ||
    account.enabled !== true ||
    capabilities.length !== 1 ||
    capabilities[0] !== 'apiKey'
  )
    throw new ArgoApiError(
      'dedicated account must be enabled with only the apiKey capability',
      'permission_denied',
    );
}

export async function verifyEffectivePermissions(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  client: ArgoClient,
): Promise<void> {
  const scopes = configuredScopes(config.settings);
  const anyNamespace = config.settings.applicationsInAnyNamespace === true;
  const objects = [...new Set(scopes.map((scope) => applicationScopeObject(scope, anyNamespace)))];
  const requiredReads = objects.flatMap((object): PermissionCheck[] => [
    { resource: 'applications', action: 'get', object },
    { resource: 'logs', action: 'get', object },
  ]);
  if ((await runPermissionChecks(fetchImpl, client, requiredReads)).some((allowed) => !allowed))
    throw new ArgoPermissionError(
      'token lacks configured applications or logs read access',
      'required_reads',
    );

  const forbidden: PermissionCheck[] = objects.flatMap((object) => [
    ...(['create', 'update', 'delete', 'sync', 'override', 'action'] as const).map((action) => ({
      resource: 'applications' as const,
      action,
      object,
    })),
    { resource: 'exec', action: 'create', object },
  ]);
  const outside = outsideApplicationObject(scopes, anyNamespace);
  const outsideProject = outside?.split('/')[0] ?? 'sre-platform-outside-scope';
  if (outside) {
    forbidden.push(
      { resource: 'applications', action: 'get', object: outside },
      { resource: 'logs', action: 'get', object: outside },
    );
  }
  forbidden.push({ resource: 'projects', action: 'get', object: outsideProject });
  const globalResources: ArgoResource[] = [
    'accounts',
    'applicationsets',
    'certificates',
    'clusters',
    'gpgkeys',
    'projects',
    'repositories',
    'write-repositories',
  ];
  for (const resource of globalResources) {
    for (const action of ['get', 'create', 'update', 'delete'] as const)
      forbidden.push({ resource, action, object: '*' });
  }
  forbidden.push({ resource: 'extensions', action: 'invoke', object: '*' });
  if ((await runPermissionChecks(fetchImpl, client, forbidden)).some(Boolean))
    throw new ArgoPermissionError(
      'token has sampled access beyond the configured read-only ArgoCD scope',
      'deny_samples',
    );
}
