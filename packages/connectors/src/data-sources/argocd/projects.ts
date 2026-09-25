import * as z from 'zod';
import type { ConnectorConfig } from '../../registry';
import type { HostLookup } from '../../ssrf';
import type { ConnectorTool, IDataSourceConnector } from '../../types';
import { obj, str } from '../../values';
import {
  ArgoApiError,
  LEGACY_PROJECT_ROLE,
  MAX_APPLICATION_SCOPES,
  MAX_NAMESPACE_CHARS,
  MAX_TOKEN_BYTES,
  NAME_RE,
  configuredScopes,
  type FetchLike,
} from './client';
import { makeSingleArgoCdConnector } from './single-connector';
import { atool } from './tools';

export interface ProjectBinding {
  project: string;
  applications: Array<{ name: string; namespace?: string }>;
}

export interface ProjectConnector {
  project: string;
  connector: IDataSourceConnector;
}

export function configuredAccessRole(settings: Record<string, unknown>): string {
  const role = str(settings.accessRole) ?? LEGACY_PROJECT_ROLE;
  if (role.length > MAX_NAMESPACE_CHARS || !NAME_RE.test(role))
    throw new ArgoApiError('argocd access role is invalid', 'permission_denied');
  return role;
}

export function configuredProjects(settings: Record<string, unknown>): ProjectBinding[] {
  if (
    !Array.isArray(settings.projects) ||
    settings.projects.length === 0 ||
    settings.projects.length > 50
  )
    throw new ArgoApiError('argocd project scope is missing or invalid', 'permission_denied');
  const accessRole = configuredAccessRole(settings);
  const seen = new Set<string>();
  let scopeCount = 0;
  return settings.projects.map((value) => {
    const raw = obj(value);
    const project = str(raw.project);
    if (!project || project === '*' || !NAME_RE.test(project) || seen.has(project))
      throw new ArgoApiError('argocd project scope is missing or invalid', 'permission_denied');
    seen.add(project);
    if (!Array.isArray(raw.applications) || raw.applications.length === 0)
      throw new ArgoApiError('argocd project scope is missing or invalid', 'permission_denied');
    const applications = raw.applications.map((applicationValue) => {
      const application = obj(applicationValue);
      const name = str(application.name);
      const namespace = str(application.namespace);
      if (!name)
        throw new ArgoApiError(
          'argocd application scope is missing or invalid',
          'permission_denied',
        );
      scopeCount += 1;
      if (scopeCount > MAX_APPLICATION_SCOPES)
        throw new ArgoApiError(
          'argocd application scope is missing or invalid',
          'permission_denied',
        );
      return { name, ...(namespace ? { namespace } : {}) };
    });
    const derived = {
      ...settings,
      identity: `proj:${project}:${accessRole}`,
      applications: applications.map((application) => ({ project, ...application })),
    };
    configuredScopes(derived);
    return { project, applications };
  });
}

export function projectTokens(value: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ArgoApiError('argocd project credentials are invalid', 'permission_denied');
  }
  const raw = obj(parsed);
  if (raw.version !== 1 || !Array.isArray(raw.tokens))
    throw new ArgoApiError('argocd project credentials are invalid', 'permission_denied');
  const tokens = new Map<string, string>();
  for (const tokenValue of raw.tokens) {
    const entry = obj(tokenValue);
    const project = str(entry.project);
    const token = str(entry.token)?.trim();
    if (
      !project ||
      project === '*' ||
      !NAME_RE.test(project) ||
      !token ||
      new TextEncoder().encode(token).byteLength > MAX_TOKEN_BYTES ||
      tokens.has(project)
    )
      throw new ArgoApiError('argocd project credentials are invalid', 'permission_denied');
    tokens.set(project, token);
  }
  return tokens;
}

export async function loadProjectConnectors(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
): Promise<ProjectConnector[]> {
  const bindings = configuredProjects(config.settings);
  const accessRole = configuredAccessRole(config.settings);
  const tokens = projectTokens(await config.getCredential());
  return bindings.map((binding) => {
    const token = tokens.get(binding.project);
    if (!token)
      throw new ArgoApiError(
        `argocd credential is missing for project ${binding.project}`,
        'permission_denied',
      );
    const settings = {
      ...config.settings,
      identity: `proj:${binding.project}:${accessRole}`,
      applications: binding.applications.map((application) => ({
        project: binding.project,
        ...application,
      })),
    };
    return {
      project: binding.project,
      connector: makeSingleArgoCdConnector(
        { ...config, settings, getCredential: async () => token },
        fetchImpl,
        lookup,
      ),
    };
  });
}

function projectTool(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
  name: string,
  inputSchema: z.ZodType,
  description: string,
): ConnectorTool {
  return atool({
    name,
    description,
    inputSchema,
    run: async (input: unknown, call) => {
      const rawInput = obj(input);
      const project = str(rawInput.project);
      if (!project || !NAME_RE.test(project))
        throw new Error('argocd connector: project is required');
      const children = await loadProjectConnectors(config, fetchImpl, lookup);
      const child = children.find((candidate) => candidate.project === project);
      if (!child) throw new Error(`argocd connector: project '${project}' is outside the scope`);
      const tool = child.connector.tools().find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`argocd connector: tool '${name}' is unavailable`);
      const { project: _project, ...childInput } = rawInput;
      return tool.run(childInput, call);
    },
  });
}

export function makeMultiProjectTools(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
): ConnectorTool[] {
  const application = {
    project: z.string(),
    name: z.string(),
    appNamespace: z.string().optional(),
  };
  return [
    atool({
      name: 'list_applications',
      description: 'List scoped ArgoCD applications across every connected project.',
      inputSchema: z.object({ project: z.string().optional() }),
      run: async ({ project }, call) => {
        const children = await loadProjectConnectors(config, fetchImpl, lookup);
        const selected = project
          ? children.filter((candidate) => candidate.project === project)
          : children;
        if (selected.length === 0)
          throw new Error(`argocd connector: project '${project}' is outside the scope`);
        const results = await Promise.all(
          selected.map(async (child) => {
            const tool = child.connector
              .tools()
              .find((candidate) => candidate.name === 'list_applications')!;
            return tool.run({}, call) as Promise<{ applications?: unknown[] }>;
          }),
        );
        return { applications: results.flatMap((result) => result.applications ?? []) };
      },
    }),
    projectTool(
      config,
      fetchImpl,
      lookup,
      'get_application',
      z.object(application),
      'Get one scoped ArgoCD application. Project is required to choose its credential.',
    ),
    projectTool(
      config,
      fetchImpl,
      lookup,
      'get_resource_tree',
      z.object(application),
      'Get the live resource tree for one scoped ArgoCD application.',
    ),
    projectTool(
      config,
      fetchImpl,
      lookup,
      'get_managed_resources',
      z.object(application),
      'Get the scrubbed live-versus-desired diff for one scoped ArgoCD application.',
    ),
    projectTool(
      config,
      fetchImpl,
      lookup,
      'get_application_events',
      z.object(application),
      'List Kubernetes events for one scoped ArgoCD application.',
    ),
    projectTool(
      config,
      fetchImpl,
      lookup,
      'get_application_logs',
      z.object({
        ...application,
        podName: z.string().optional(),
        container: z.string().optional(),
        namespace: z.string().optional(),
        tailLines: z.number().int().positive().optional(),
        sinceSeconds: z.number().int().positive().optional(),
      }),
      'Read bounded pod logs for one scoped ArgoCD application.',
    ),
    projectTool(
      config,
      fetchImpl,
      lookup,
      'api_get',
      z.object({
        project: z.string(),
        path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
      'GET a safe non-Application ArgoCD API endpoint with one project credential.',
    ),
  ];
}
