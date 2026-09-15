import {
  argoCdAccessCommands,
  discoverGitHubInstallations,
  discoverGitHubRepositories,
  discoverGitLabGroup,
  gitLabDiscoveryFailure,
  discoverGitLabProjects,
  generateArgoCdAccess,
  gitLabAccessToken,
  githubPrivateKey,
  kubernetesRbacManifest,
} from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  listGitHubRepositories,
  withTenant,
} from '@sre/db';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { type TenantAuthVariables } from '../../auth';

import {
  boundedArgoCdJson,
  connectorInstanceId,
  githubInstallationDiscoveryFailure,
  lockConnectorLifecycle,
  mergeLegacyGitHubSettings,
  parseGitHubAppSettings,
  parseGitHubRepositorySettings,
  parseGitLabBaseUrl,
  parseGitLabSettings,
  parseLegacyGitHubCredential,
  requestObject,
} from '../helpers';

export type { ConnectorRoutesDeps } from '../helpers';

import type { ConnectorRouteContext } from './context';

export function registerConnectorDiscoveryRoutes(
  r: Hono<{ Variables: TenantAuthVariables }>,
  context: ConnectorRouteContext,
): void {
  const { deps, serializeMutation, legacyConnectorId } = context;
  r.post('/:type/projects', async (c) => {
    const { tenantId } = c.get('tenant');
    if (c.req.param('type') !== 'gitlab')
      return c.json({ error: 'project discovery is only available for GitLab' }, 400);
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const body = requestObject(parsed);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    let dataSourceId =
      body.dataSourceId === undefined ? undefined : connectorInstanceId(body.dataSourceId);
    if (body.dataSourceId !== undefined && !dataSourceId)
      return c.json({ error: 'invalid data source ID' }, 400);
    if (
      Object.prototype.hasOwnProperty.call(body, 'credential') &&
      typeof body.credential !== 'string'
    )
      return c.json({ error: 'credential must be a string' }, 400);
    const baseUrl = parseGitLabBaseUrl(body.settings);
    if (!baseUrl) return c.json({ error: 'invalid GitLab URL' }, 400);
    const rawDiscoverySettings = requestObject(body.settings) ?? {};
    const groupPath =
      typeof rawDiscoverySettings.groupPath === 'string'
        ? rawDiscoverySettings.groupPath.trim()
        : undefined;
    if (groupPath !== undefined && !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(groupPath))
      return c.json({ error: 'invalid GitLab group path' }, 400);
    const enteredCredential =
      typeof body.credential === 'string' ? body.credential.trim() : undefined;
    if (!dataSourceId && !enteredCredential) {
      const legacyId = await legacyConnectorId(tenantId, 'gitlab');
      if (legacyId === 'ambiguous')
        return c.json({ error: 'dataSourceId is required when multiple connections exist' }, 409);
      dataSourceId = legacyId ?? undefined;
    }
    return serializeMutation(tenantId, dataSourceId ?? 'gitlab-discovery', async () => {
      try {
        const outcome = await withTenant(deps.db, tenantId, async (tx) => {
          let credential = enteredCredential;
          if (!credential) {
            if (!dataSourceId) return { error: 'credential is required' };
            await lockConnectorLifecycle(tx, tenantId, dataSourceId);
            const rows = await tx
              .select({ settings: connectorConfigs.settings })
              .from(connectorConfigs)
              .where(
                and(
                  eq(connectorConfigs.id, dataSourceId),
                  eq(connectorConfigs.type, 'gitlab'),
                  isNull(connectorConfigs.deletedAt),
                ),
              )
              .limit(1);
            const savedSettings = parseGitLabSettings(rows[0]?.settings);
            if (
              !savedSettings ||
              savedSettings.baseUrl !== baseUrl ||
              (groupPath !== undefined && savedSettings.groupPath !== groupPath)
            )
              return { error: 'a new credential is required when the GitLab URL or group changes' };
            const stored = await deps.secrets.get(
              tenantId,
              connectorCredentialKey(dataSourceId),
              tx,
            );
            credential = stored ? (gitLabAccessToken(stored) ?? undefined) : undefined;
          }
          if (!credential) return { error: 'credential is required' };
          if (groupPath !== undefined) {
            const discover = deps.discoverGitLabGroup ?? discoverGitLabGroup;
            return { discovery: await discover({ baseUrl, groupPath }, credential) };
          }
          const discoverLegacy = deps.discoverGitLabProjects ?? discoverGitLabProjects;
          return { projects: await discoverLegacy({ baseUrl }, credential) };
        });
        if ('error' in outcome) return c.json({ error: outcome.error }, 400);
        return 'discovery' in outcome
          ? c.json(outcome.discovery)
          : c.json({ projects: outcome.projects });
      } catch (error) {
        const failure = gitLabDiscoveryFailure(error);
        const reference = crypto.randomUUID();
        deps.log?.error('GitLab discovery failed', {
          tenantId,
          reference,
          failureCategory: failure.code,
          stage: failure.stage,
          ...(failure.upstreamStatus ? { upstreamStatus: failure.upstreamStatus } : {}),
        });
        return c.json(
          { error: failure.message, code: failure.code, stage: failure.stage, reference },
          502,
        );
      }
    });
  });

  r.post('/github/installations', async (c) => {
    const { tenantId } = c.get('tenant');
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const body = requestObject(parsed);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    let dataSourceId =
      body.dataSourceId === undefined ? undefined : connectorInstanceId(body.dataSourceId);
    if (body.dataSourceId !== undefined && !dataSourceId)
      return c.json({ error: 'invalid data source ID' }, 400);
    const credentialProvided = Object.prototype.hasOwnProperty.call(body, 'credential');
    if (credentialProvided && typeof body.credential !== 'string')
      return c.json({ error: 'credential must be a string' }, 400);
    const enteredCredential =
      typeof body.credential === 'string' ? body.credential.trim() : undefined;
    if (credentialProvided && !enteredCredential)
      return c.json({ error: 'credential must not be blank' }, 400);
    if (!dataSourceId && !enteredCredential) {
      const legacyId = await legacyConnectorId(tenantId, 'github');
      if (legacyId === 'ambiguous')
        return c.json({ error: 'dataSourceId is required when multiple connections exist' }, 409);
      dataSourceId = legacyId ?? undefined;
    }
    const submittedLegacy = parseLegacyGitHubCredential(enteredCredential);
    const requestedSettings = parseGitHubAppSettings(
      mergeLegacyGitHubSettings(body.settings, submittedLegacy),
    );
    if (!requestedSettings) return c.json({ error: 'invalid GitHub App ID' }, 400);

    return serializeMutation(
      tenantId,
      dataSourceId ?? 'github-installation-discovery',
      async () => {
        try {
          const captured = await withTenant(deps.db, tenantId, async (tx) => {
            if (dataSourceId) await lockConnectorLifecycle(tx, tenantId, dataSourceId);
            const rows = dataSourceId
              ? await tx
                  .select({ settings: connectorConfigs.settings })
                  .from(connectorConfigs)
                  .where(
                    and(
                      eq(connectorConfigs.id, dataSourceId),
                      eq(connectorConfigs.type, 'github'),
                      isNull(connectorConfigs.deletedAt),
                    ),
                  )
                  .limit(1)
              : [];
            const savedCredential = dataSourceId
              ? await deps.secrets.get(tenantId, connectorCredentialKey(dataSourceId), tx)
              : null;
            const savedLegacy = parseLegacyGitHubCredential(savedCredential);
            const savedSettings = parseGitHubAppSettings(
              mergeLegacyGitHubSettings(rows[0]?.settings, savedLegacy),
            );
            const privateKey =
              submittedLegacy?.privateKey ??
              enteredCredential ??
              savedLegacy?.privateKey ??
              (savedCredential ? githubPrivateKey(savedCredential) : null);
            if (!privateKey) return { error: 'credential is required' };
            if (!enteredCredential && savedSettings?.appId !== requestedSettings.appId)
              return { error: 'a new private key is required when the GitHub App ID changes' };
            return { settings: requestedSettings, privateKey };
          });
          if ('error' in captured) return c.json({ error: captured.error }, 400);
          const discover = deps.discoverGitHubInstallations ?? discoverGitHubInstallations;
          return c.json({ installations: await discover(captured.settings, captured.privateKey) });
        } catch (error) {
          const failure = githubInstallationDiscoveryFailure(error);
          deps.log?.error('GitHub installation discovery failed', {
            tenantId,
            connectorType: 'github',
            operation: 'installation_discovery',
            failureCategory: failure.code,
            ...(failure.upstreamStatus !== null ? { upstreamStatus: failure.upstreamStatus } : {}),
            ...(failure.rateLimitRemaining !== undefined
              ? { rateLimitRemaining: failure.rateLimitRemaining }
              : {}),
            ...(failure.rateLimitResetAt ? { rateLimitResetAt: failure.rateLimitResetAt } : {}),
          });
          return c.json(
            {
              error: failure.message,
              code: failure.code,
              ...(failure.rateLimitResetAt ? { retryAt: failure.rateLimitResetAt } : {}),
            },
            failure.status,
          );
        }
      },
    );
  });

  r.get('/github/repositories', async (c) => {
    const { tenantId } = c.get('tenant');
    const dataSourceId = connectorInstanceId(c.req.query('dataSourceId'));
    if (!dataSourceId) return c.json({ error: 'dataSourceId is required' }, 400);
    const query = c.req.query('query')?.trim();
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return c.json({ error: 'limit must be an integer between 1 and 100' }, 400);
    const repositories = await listGitHubRepositories(deps.db, tenantId, dataSourceId, {
      query,
      limit,
    });
    return c.json({ repositories });
  });

  r.post('/github/repositories', async (c) => {
    const { tenantId } = c.get('tenant');
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const body = requestObject(parsed);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    let dataSourceId =
      body.dataSourceId === undefined ? undefined : connectorInstanceId(body.dataSourceId);
    if (body.dataSourceId !== undefined && !dataSourceId)
      return c.json({ error: 'invalid data source ID' }, 400);
    const credentialProvided = Object.prototype.hasOwnProperty.call(body, 'credential');
    if (credentialProvided && typeof body.credential !== 'string')
      return c.json({ error: 'credential must be a string' }, 400);
    const enteredCredential =
      typeof body.credential === 'string' ? body.credential.trim() : undefined;
    if (credentialProvided && !enteredCredential)
      return c.json({ error: 'credential must not be blank' }, 400);
    if (!dataSourceId && !enteredCredential) {
      const legacyId = await legacyConnectorId(tenantId, 'github');
      if (legacyId === 'ambiguous')
        return c.json({ error: 'dataSourceId is required when multiple connections exist' }, 409);
      dataSourceId = legacyId ?? undefined;
    }
    const submittedLegacy = parseLegacyGitHubCredential(enteredCredential);
    const requestedSettings = parseGitHubRepositorySettings(
      mergeLegacyGitHubSettings(body.settings, submittedLegacy),
    );
    if (!requestedSettings) return c.json({ error: 'invalid GitHub installation settings' }, 400);

    return serializeMutation(tenantId, dataSourceId ?? 'github-repository-discovery', async () => {
      try {
        const captured = await withTenant(deps.db, tenantId, async (tx) => {
          if (dataSourceId) await lockConnectorLifecycle(tx, tenantId, dataSourceId);
          const rows = dataSourceId
            ? await tx
                .select({ settings: connectorConfigs.settings })
                .from(connectorConfigs)
                .where(
                  and(
                    eq(connectorConfigs.id, dataSourceId),
                    eq(connectorConfigs.type, 'github'),
                    isNull(connectorConfigs.deletedAt),
                  ),
                )
                .limit(1)
            : [];
          const savedCredential = dataSourceId
            ? await deps.secrets.get(tenantId, connectorCredentialKey(dataSourceId), tx)
            : null;
          const savedLegacy = parseLegacyGitHubCredential(savedCredential);
          const savedSettings = parseGitHubAppSettings(
            mergeLegacyGitHubSettings(rows[0]?.settings, savedLegacy),
          );
          const privateKey =
            submittedLegacy?.privateKey ??
            enteredCredential ??
            savedLegacy?.privateKey ??
            (savedCredential ? githubPrivateKey(savedCredential) : null);
          if (!privateKey) return { error: 'credential is required' };
          if (!enteredCredential && savedSettings?.appId !== requestedSettings.appId)
            return { error: 'a new private key is required when the GitHub App ID changes' };
          return { settings: requestedSettings, privateKey };
        });
        if ('error' in captured) return c.json({ error: captured.error }, 400);
        const discover = deps.discoverGitHubRepositories ?? discoverGitHubRepositories;
        return c.json({ repositories: await discover(captured.settings, captured.privateKey) });
      } catch {
        return c.json({ error: 'GitHub repository discovery failed' }, 502);
      }
    });
  });

  r.post('/argocd/access', async (c) => {
    let parsed: unknown;
    try {
      parsed = await boundedArgoCdJson(c.req.raw);
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const body = requestObject(parsed);
    if (
      !body ||
      typeof body.project !== 'string' ||
      (body.role !== undefined && typeof body.role !== 'string') ||
      (body.applicationsInAnyNamespace !== true && body.applicationsInAnyNamespace !== false) ||
      !Array.isArray(body.applications)
    )
      return c.json({ error: 'invalid ArgoCD access scope' }, 400);
    try {
      const instructions = generateArgoCdAccess({
        project: body.project,
        ...(typeof body.role === 'string' ? { role: body.role } : {}),
        applicationsInAnyNamespace: body.applicationsInAnyNamespace === true,
        applications: body.applications as Array<{
          name: string;
          namespace?: string;
        }>,
      });
      return c.json({ instructions, commands: argoCdAccessCommands(instructions) });
    } catch {
      return c.json({ error: 'invalid ArgoCD access scope' }, 400);
    }
  });

  // Renders the least-privilege RBAC bundle the tenant applies to their cluster. A GET, so the
  // router's change tier lets any authed tenant member read it. Params are validated inside the
  // generator (segment charset), so a crafted name cannot inject YAML; on failure we return a
  // fixed message and never echo the raw input (CWE-209).
  r.get('/:type/manifest', (c) => {
    if (c.req.param('type') !== 'kubernetes')
      return c.json({ error: 'manifest is only available for the kubernetes connector' }, 400);
    const namespace = c.req.query('namespace') ?? 'sre-triage';
    const serviceAccount = c.req.query('serviceAccount') ?? 'sre-triage-reader';
    try {
      return c.text(kubernetesRbacManifest({ namespace, serviceAccount }));
    } catch {
      return c.json({ error: 'invalid namespace or service account name' }, 400);
    }
  });

  // Test-connection: builds the connector and runs its probe. `healthy`/`unhealthy` flip `enabled`
  // (unconditional write so the row always equals the response — gating would leave a now-failing
  // connector stuck enabled, a fail-open). `not_applicable` (inbound-only stubs) leaves it untouched.
  // Because it writes, it is a configuration change, so the router's change tier restricts it to an
  // owner or administrator (CONTEXT.md, Trust Boundary). All reads/writes via withTenant so a caller
  // only ever probes its own row (RLS), which remains the tenant-isolation control.
}
