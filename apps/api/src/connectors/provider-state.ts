import { gitLabSmeeUrl, gitLabWebhookSecret, gitLabWebhookSigningToken } from '@sre/connectors';
import { issueManagementSchema } from '@sre/connectors';
import { connectorConfigs, connectorCredentialKey, type SecretStore, type Tx } from '@sre/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { ArgoCdSettings, GitLabSettings } from './contracts';
import { parseArgoCdCredentialBundle, parseArgoCdSettings } from './observability-argocd';

export interface StoredArgoCdState {
  id: string;
  name: string;
  lifecycleVersion: number;
  settings: ArgoCdSettings;
  credential: string;
}

export async function readStoredArgoCdState(
  tx: Tx,
  tenantId: string,
  connectorId: string,
  secrets: SecretStore,
): Promise<StoredArgoCdState | null> {
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
        eq(connectorConfigs.type, 'argocd'),
        isNull(connectorConfigs.deletedAt),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  const settings = parseArgoCdSettings(rows[0].settings);
  const credential = await secrets.get(tenantId, connectorCredentialKey(connectorId), tx);
  return settings && parseArgoCdCredentialBundle(credential)
    ? {
        id: rows[0].id,
        name: rows[0].name,
        lifecycleVersion: rows[0].lifecycleVersion,
        settings,
        credential: credential!,
      }
    : null;
}

export function parseGitLabBaseUrl(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const baseValue = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : 'https://gitlab.com';
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseValue);
  } catch {
    return null;
  }
  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  )
    return null;
  return baseUrl.href.replace(/\/$/, '');
}

export function parseGitLabSettings(input: unknown): GitLabSettings | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (
    raw.issueManagement !== undefined &&
    !issueManagementSchema.safeParse(raw.issueManagement).success
  )
    return null;
  const issues =
    raw.issueManagement === undefined
      ? {}
      : { issueManagement: issueManagementSchema.parse(raw.issueManagement) };
  const baseUrl = parseGitLabBaseUrl(input);
  if (!baseUrl) return null;
  const groupId = raw.groupId;
  const validGroupId =
    (typeof groupId === 'number' && Number.isSafeInteger(groupId) && groupId > 0) ||
    (typeof groupId === 'string' && /^\d+$/.test(groupId.trim()));
  const groupPath = typeof raw.groupPath === 'string' ? raw.groupPath.trim() : undefined;
  const validGroupPath =
    groupPath !== undefined &&
    groupPath.length <= 255 &&
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(groupPath);
  const eventTransport = raw.eventTransport ?? 'none';
  const hookScope = raw.hookScope;
  const eventStrategy = raw.eventStrategy;
  if (
    eventStrategy !== undefined &&
    eventStrategy !== 'group' &&
    eventStrategy !== 'managed_projects' &&
    eventStrategy !== 'system'
  )
    return null;
  if (hookScope !== undefined && hookScope !== 'projects' && hookScope !== 'group') return null;
  const validEventTransport =
    eventTransport === 'direct' || eventTransport === 'smee' || eventTransport === 'none';
  if (
    (raw.groupId !== undefined || raw.groupPath !== undefined) &&
    validGroupId &&
    validGroupPath
  ) {
    if (!validEventTransport) return null;
    const groupName = typeof raw.groupName === 'string' ? raw.groupName.trim() : undefined;
    if (raw.groupName !== undefined && !groupName) return null;
    return {
      baseUrl,
      ...issues,
      groupId: typeof groupId === 'string' ? groupId.trim() : groupId,
      groupPath,
      ...(groupName ? { groupName } : {}),
      eventTransport,
      ...(hookScope ? { hookScope } : {}),
      ...(eventStrategy ? { eventStrategy } : {}),
    };
  }

  // Existing saved connectors remain operable until the operator migrates them in the wizard.
  const projectId = raw.projectId;
  if (!(
    (typeof projectId === 'number' && Number.isSafeInteger(projectId) && projectId > 0) ||
    (typeof projectId === 'string' && projectId.trim().length > 0)
  ))
    return null;
  const service = typeof raw.service === 'string' ? raw.service.trim() : undefined;
  if (raw.service !== undefined && !service) return null;
  return {
    baseUrl,
    projectId: typeof projectId === 'string' ? projectId.trim() : projectId,
    ...issues,
    ...(service ? { service } : {}),
  };
}

export function publicGitLabSettings(
  input: unknown,
  credential: string | null,
): Record<string, unknown> {
  const settings = parseGitLabSettings(input);
  if (!settings) return {};
  return {
    ...settings,
    ...(settings.eventTransport === 'smee'
      ? { smeeConfigured: Boolean(credential && gitLabSmeeUrl(credential)) }
      : {}),
    ...(settings.eventTransport && settings.eventTransport !== 'none'
      ? {
          webhookSigningTokenConfigured: Boolean(
            credential && gitLabWebhookSigningToken(credential),
          ),
          webhookSecretConfigured: Boolean(credential && gitLabWebhookSecret(credential)),
        }
      : {}),
  };
}
