import { githubPrivateKey, githubWebhookSecret } from '@sre/connectors';
import { issueManagementSchema } from '@sre/connectors';
import { connectorConfigs, connectorCredentialKey, type SecretStore, type Tx } from '@sre/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { GitHubSettings } from './contracts';
import { githubAppId, positiveId, requestObject } from './shared';

export const GITHUB_PERMISSION_KEYS = [
  'deployments',
  'metadata',
  'contents',
  'pull_requests',
  'actions',
] as const;

export function parseGitHubPermissions(
  input: unknown,
): Record<string, 'read' | 'write'> | undefined {
  const raw = requestObject(input);
  if (!raw) return undefined;
  const permissions = Object.fromEntries(
    GITHUB_PERMISSION_KEYS.flatMap((key) => {
      const value = raw[key];
      return value === 'read' || value === 'write' ? [[key, value]] : [];
    }),
  ) as Record<string, 'read' | 'write'>;
  return Object.keys(permissions).length > 0 ? permissions : undefined;
}

export interface LegacyGitHubCredential {
  appId: string;
  installationId: string;
  privateKey: string;
}

export function parseLegacyGitHubCredential(
  input: string | null | undefined,
): LegacyGitHubCredential | null {
  if (!input) return null;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  const raw = requestObject(value);
  if (!raw) return null;
  const appId = githubAppId(raw.appId);
  const installationId = positiveId(raw.installationId);
  const privateKey = typeof raw.privateKey === 'string' ? raw.privateKey.trim() : '';
  return appId && installationId && privateKey ? { appId, installationId, privateKey } : null;
}

export function parseGitHubAppSettings(input: unknown): { appId: string } | null {
  const raw = requestObject(input);
  const appId = githubAppId(raw?.appId);
  return appId ? { appId } : null;
}

export function parseGitHubRepositorySettings(
  input: unknown,
): { appId: string; installationId: string } | null {
  const raw = requestObject(input);
  const appId = githubAppId(raw?.appId);
  const installationId = positiveId(raw?.installationId);
  return appId && installationId ? { appId, installationId } : null;
}

export function parseGitHubSettings(input: unknown): GitHubSettings | null {
  const raw = requestObject(input);
  if (!raw) return null;
  if (
    raw.issueManagement !== undefined &&
    !issueManagementSchema.safeParse(raw.issueManagement).success
  )
    return null;
  const appId = githubAppId(raw.appId);
  const installationId = positiveId(raw.installationId);
  if (!appId || !installationId) return null;
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : undefined;
  if (raw.repo !== undefined && (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo))) return null;
  const service = typeof raw.service === 'string' ? raw.service.trim() : undefined;
  if (raw.service !== undefined && !service) return null;
  const accountLogin = typeof raw.accountLogin === 'string' ? raw.accountLogin.trim() : undefined;
  if (raw.accountLogin !== undefined && !accountLogin) return null;
  const repositorySelection = raw.repositorySelection;
  if (
    repositorySelection !== undefined &&
    repositorySelection !== 'all' &&
    repositorySelection !== 'selected'
  )
    return null;
  const permissions = parseGitHubPermissions(raw.permissions);
  const appSlug = typeof raw.appSlug === 'string' ? raw.appSlug.trim() : undefined;
  if (raw.appSlug !== undefined && !appSlug) return null;
  const eventTransport = raw.eventTransport;
  if (eventTransport !== undefined && eventTransport !== 'direct' && eventTransport !== 'smee')
    return null;
  return {
    appId,
    installationId,
    ...(raw.issueManagement !== undefined
      ? { issueManagement: issueManagementSchema.parse(raw.issueManagement) }
      : {}),
    ...(repo ? { repo } : {}),
    ...(service ? { service } : {}),
    ...(accountLogin ? { accountLogin } : {}),
    ...(repositorySelection ? { repositorySelection } : {}),
    ...(permissions ? { permissions } : {}),
    ...(appSlug ? { appSlug } : {}),
    ...(eventTransport ? { eventTransport } : {}),
  };
}

export function mergeLegacyGitHubSettings(
  settings: unknown,
  legacy: LegacyGitHubCredential | null,
): Record<string, unknown> {
  return {
    ...requestObject(settings),
    ...(legacy ? { appId: legacy.appId, installationId: legacy.installationId } : {}),
  };
}

export function publicGitHubSettings(
  input: unknown,
  legacy: LegacyGitHubCredential | null,
  smeeConfigured: boolean,
) {
  const raw = mergeLegacyGitHubSettings(input, legacy);
  const full = parseGitHubSettings(raw);
  if (full)
    return {
      ...full,
      ...(full.eventTransport === 'smee' ? { smeeConfigured } : {}),
    };
  const appId = githubAppId(raw.appId);
  const appSlug = typeof raw.appSlug === 'string' ? raw.appSlug.trim() : undefined;
  const eventTransport =
    raw.eventTransport === 'smee' || raw.eventTransport === 'direct'
      ? raw.eventTransport
      : undefined;
  return {
    ...(appId ? { appId } : {}),
    ...(appSlug ? { appSlug } : {}),
    ...(eventTransport ? { eventTransport } : {}),
    ...(eventTransport === 'smee' ? { smeeConfigured } : {}),
  };
}

export interface StoredGitHubState {
  id: string;
  name: string;
  lifecycleVersion: number;
  rawSettings: unknown;
  rawCredential: string | null;
  settings: GitHubSettings;
  privateKey: string;
  credential: string;
  webhookSecret: string | null;
  legacy: LegacyGitHubCredential | null;
}

export async function readStoredGitHubState(
  tx: Tx,
  tenantId: string,
  connectorId: string,
  secrets: SecretStore,
): Promise<StoredGitHubState | null> {
  const rows = await tx
    .select({
      id: connectorConfigs.id,
      name: connectorConfigs.name,
      lifecycleVersion: connectorConfigs.lifecycleVersion,
      settings: connectorConfigs.settings,
    })
    .from(connectorConfigs)
    .where(
      and(
        eq(connectorConfigs.id, connectorId),
        eq(connectorConfigs.type, 'github'),
        isNull(connectorConfigs.deletedAt),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  const rawCredential = await secrets.get(tenantId, connectorCredentialKey(connectorId), tx);
  const legacy = parseLegacyGitHubCredential(rawCredential);
  const settings = parseGitHubSettings(mergeLegacyGitHubSettings(rows[0].settings, legacy));
  const privateKey = legacy?.privateKey ?? (rawCredential ? githubPrivateKey(rawCredential) : null);
  if (!settings || !privateKey) return null;
  return {
    id: rows[0].id,
    name: rows[0].name,
    lifecycleVersion: rows[0].lifecycleVersion,
    rawSettings: rows[0].settings,
    rawCredential,
    settings,
    privateKey,
    credential: rawCredential!,
    webhookSecret: rawCredential ? githubWebhookSecret(rawCredential) : null,
    legacy,
  };
}

export function storedGitHubStateMatches(a: StoredGitHubState, b: StoredGitHubState): boolean {
  return (
    a.lifecycleVersion === b.lifecycleVersion &&
    a.rawCredential === b.rawCredential &&
    JSON.stringify(a.rawSettings) === JSON.stringify(b.rawSettings)
  );
}
