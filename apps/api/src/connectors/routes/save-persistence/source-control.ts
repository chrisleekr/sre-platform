import {
  gitLabAccessToken,
  gitLabCredentialBundle,
  gitLabSmeeUrl,
  gitLabWebhookSecret,
  gitLabWebhookSigningToken,
  githubCredentialBundle,
  githubPrivateKey,
  githubSmeeUrl,
  githubWebhookSecret,
} from '@sre/connectors';
import { connectorConfigs, connectorCredentialKey, resetGitLabPolling } from '@sre/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  lockConnectorLifecycle,
  mergeLegacyGitHubSettings,
  parseGitHubSettings,
  parseGitLabSettings,
  parseLegacyGitHubCredential,
  requestObject,
  smeeUrlInput,
} from '../../helpers';
import type { ProviderSaveHandler } from './contracts';

export const saveGitLab: ProviderSaveHandler = async (input, current, initial) => {
  const {
    tx,
    deps,
    tenantId,
    connectorId,
    body,
    credential,
    submittedWebhookSecret,
    submittedWebhookSigningToken,
  } = input;
  const savedCredential = await deps.secrets.get(tenantId, connectorCredentialKey(connectorId), tx);
  const savedSettings = parseGitLabSettings(current?.settings);
  const requestedSettings = parseGitLabSettings(initial.settings);
  const accessToken = credential ?? (savedCredential ? gitLabAccessToken(savedCredential) : null);
  if (!accessToken) return 'credential is required';
  if (
    (!savedSettings ||
      !requestedSettings ||
      savedSettings.baseUrl !== requestedSettings.baseUrl ||
      String(savedSettings.groupId ?? '') !== String(requestedSettings.groupId ?? '')) &&
    !credential
  )
    return 'a new credential is required when the GitLab URL or group changes';
  const webhookSecret =
    submittedWebhookSecret ??
    (savedCredential ? gitLabWebhookSecret(savedCredential) : null) ??
    undefined;
  const webhookSigningToken =
    submittedWebhookSigningToken ??
    (savedCredential ? gitLabWebhookSigningToken(savedCredential) : null) ??
    undefined;
  const rawRequestedSettings = requestObject(body.settings);
  const submittedSmeeUrl = smeeUrlInput(rawRequestedSettings?.smeeUrl);
  if (rawRequestedSettings?.smeeUrl !== undefined && !submittedSmeeUrl)
    return 'invalid GitLab Smee channel URL';
  const smeeUrl =
    requestedSettings?.eventTransport === 'smee'
      ? (submittedSmeeUrl ??
        (savedSettings?.eventTransport === 'smee' && savedCredential
          ? gitLabSmeeUrl(savedCredential)
          : null))
      : null;
  if (requestedSettings?.eventTransport === 'smee' && !smeeUrl)
    return 'a Smee channel URL is required for local GitLab event delivery';
  if (
    requestedSettings?.groupId != null &&
    requestedSettings.eventTransport !== 'none' &&
    !webhookSecret &&
    !webhookSigningToken
  )
    return 'a webhook signing token or secret is required when GitLab event sync is enabled';
  const credentialToSave =
    requestedSettings?.groupId != null
      ? gitLabCredentialBundle(accessToken, {
          ...(webhookSecret ? { webhookSecret } : {}),
          ...(webhookSigningToken ? { webhookSigningToken } : {}),
          ...(smeeUrl ? { smeeUrl } : {}),
        })
      : accessToken;
  const scopeChanged = Boolean(
    savedSettings &&
    requestedSettings &&
    (savedSettings.baseUrl !== requestedSettings.baseUrl ||
      String(savedSettings.groupId) !== String(requestedSettings.groupId) ||
      savedSettings.groupPath !== requestedSettings.groupPath),
  );
  if (
    current &&
    (scopeChanged || savedSettings?.eventStrategy !== requestedSettings?.eventStrategy)
  ) {
    await resetGitLabPolling(tx, tenantId, connectorId, scopeChanged);
  }
  return { ...initial, credentialToSave };
};

export const saveGitHub: ProviderSaveHandler = async (input, current, initial) => {
  const {
    tx,
    deps,
    tenantId,
    connectorId,
    body,
    credential,
    submittedWebhookSecret,
    submittedLegacy,
  } = input;
  const savedCredential = await deps.secrets.get(tenantId, connectorCredentialKey(connectorId), tx);
  const savedLegacy = parseLegacyGitHubCredential(savedCredential);
  const requestedSettings = parseGitHubSettings(
    mergeLegacyGitHubSettings(body.settings, submittedLegacy ?? savedLegacy),
  );
  if (!requestedSettings) return 'invalid GitHub settings';
  await lockConnectorLifecycle(tx, tenantId, `github-app:${requestedSettings.appId}`);
  const duplicateApp = await tx
    .select({ id: connectorConfigs.id })
    .from(connectorConfigs)
    .where(
      and(
        eq(connectorConfigs.type, 'github'),
        ne(connectorConfigs.id, connectorId),
        isNull(connectorConfigs.deletedAt),
        sql`${connectorConfigs.settings}->>'appId' = ${requestedSettings.appId}`,
      ),
    )
    .limit(1);
  if (duplicateApp[0])
    return 'this GitHub App is already connected; use a separate dedicated App for another data source';
  const savedSettings = parseGitHubSettings(
    mergeLegacyGitHubSettings(current?.settings, savedLegacy),
  );
  const rawRequestedSettings = requestObject(body.settings);
  const submittedSmeeUrl = smeeUrlInput(rawRequestedSettings?.smeeUrl);
  if (rawRequestedSettings?.smeeUrl !== undefined && !submittedSmeeUrl)
    return 'invalid GitHub Smee channel URL';
  const privateKey =
    submittedLegacy?.privateKey ??
    credential ??
    savedLegacy?.privateKey ??
    (savedCredential ? githubPrivateKey(savedCredential) : undefined);
  const webhookSecret =
    submittedWebhookSecret ?? (savedCredential ? githubWebhookSecret(savedCredential) : null);
  if (!privateKey) return 'private key is required';
  if (!webhookSecret) return 'webhook secret is required';
  const smeeUrl =
    requestedSettings.eventTransport === 'smee'
      ? (submittedSmeeUrl ??
        (savedSettings?.eventTransport === 'smee' && savedCredential
          ? githubSmeeUrl(savedCredential)
          : null))
      : null;
  if (requestedSettings.eventTransport === 'smee' && !smeeUrl)
    return 'a Smee channel URL is required for local event delivery';
  if (
    (!savedSettings || savedSettings.appId !== requestedSettings.appId) &&
    (!credential || !submittedWebhookSecret)
  )
    return 'a new private key and webhook secret are required when the GitHub App ID changes';
  return {
    ...initial,
    settings: requestedSettings as unknown as Record<string, unknown>,
    credentialToSave: githubCredentialBundle(privateKey, webhookSecret, smeeUrl ?? undefined),
  };
};
