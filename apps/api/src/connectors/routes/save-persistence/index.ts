import { connectorCapabilities, issueManagement, type ConnectorType } from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  connectorEventCredentialKey,
  connectorIssueCredentialKey,
} from '@sre/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { lockConnectorLifecycle, requestObject } from '../../helpers';
import type {
  CurrentConnector,
  ProviderSaveHandler,
  ProviderSaveResult,
  SavePersistenceInput,
} from './contracts';
import { saveKubernetes } from './kubernetes';
import { saveDatadog, saveGrafana, savePrometheus, saveStatusCake } from './observability';
import { saveGitHub, saveGitLab } from './source-control';

const providerSaveHandlers: Partial<Record<ConnectorType, ProviderSaveHandler>> = {
  kubernetes: saveKubernetes,
  prometheus: savePrometheus,
  statuscake: saveStatusCake,
  datadog: saveDatadog,
  grafana: saveGrafana,
  gitlab: saveGitLab,
  github: saveGitHub,
};

async function currentConnector(
  input: SavePersistenceInput,
): Promise<CurrentConnector | undefined> {
  const rows = await input.tx
    .select({
      name: connectorConfigs.name,
      settings: connectorConfigs.settings,
      webhookKey: connectorConfigs.webhookKey,
    })
    .from(connectorConfigs)
    .where(
      and(
        eq(connectorConfigs.id, input.connectorId),
        eq(connectorConfigs.type, input.type),
        isNull(connectorConfigs.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

async function singletonConflict(input: SavePersistenceInput): Promise<boolean> {
  if (!input.creating || connectorCapabilities(input.type).instances !== 'singleton') return false;
  await lockConnectorLifecycle(input.tx, input.tenantId, input.type);
  const existing = await input.tx
    .select({ id: connectorConfigs.id })
    .from(connectorConfigs)
    .where(and(eq(connectorConfigs.type, input.type), isNull(connectorConfigs.deletedAt)))
    .limit(1);
  return Boolean(existing[0]);
}

async function persistRecord(
  input: SavePersistenceInput,
  current: CurrentConnector | undefined,
  result: ProviderSaveResult,
): Promise<void> {
  const { tx, connectorId, tenantId, type, creating, requestedName, enabled } = input;
  if (creating) {
    await tx.insert(connectorConfigs).values({
      id: connectorId,
      tenantId,
      name: requestedName!,
      type,
      settings: result.settings,
      enabled,
      ...(type === 'github' || type === 'gitlab' || type === 'prometheus'
        ? { webhookKey: connectorId }
        : {}),
    });
  } else {
    await tx
      .update(connectorConfigs)
      .set({
        name: requestedName ?? current!.name,
        settings: result.settings,
        enabled,
        webhookKey:
          (type === 'github' || type === 'gitlab' || type === 'prometheus') && !current!.webhookKey
            ? connectorId
            : undefined,
        lifecycleVersion: sql`${connectorConfigs.lifecycleVersion} + 1`,
        verificationAttemptedAt: null,
        verificationSucceededAt: null,
        verificationFailureCategory: null,
        verificationDurationMs: null,
        verificationRateLimitRemaining: type === 'github' ? null : undefined,
        verificationRateLimitResetAt: type === 'github' ? null : undefined,
        pollAttemptedAt: connectorCapabilities(type).polling === 'snapshots' ? null : undefined,
        pollSucceededAt: connectorCapabilities(type).polling === 'snapshots' ? null : undefined,
        pollSnapshotCount: connectorCapabilities(type).polling === 'snapshots' ? 0 : undefined,
        pollErrorCount: connectorCapabilities(type).polling === 'snapshots' ? 0 : undefined,
        pollFailureCategory: connectorCapabilities(type).polling === 'snapshots' ? null : undefined,
        pollDurationMs: connectorCapabilities(type).polling === 'snapshots' ? null : undefined,
        pollRateLimitRemaining: type === 'github' ? null : undefined,
        pollRateLimitResetAt: type === 'github' ? null : undefined,
        pollCursor: type === 'github' ? null : undefined,
        eventAttemptedAt: connectorCapabilities(type).events === 'authenticated' ? null : undefined,
        eventSucceededAt: connectorCapabilities(type).events === 'authenticated' ? null : undefined,
        eventCount: connectorCapabilities(type).events === 'authenticated' ? 0 : undefined,
        eventFailureCategory:
          connectorCapabilities(type).events === 'authenticated' ? null : undefined,
        updatedAt: sql`now()`,
      })
      .where(eq(connectorConfigs.id, connectorId));
  }
  if (result.credentialToSave !== undefined)
    await input.deps.secrets.put(
      tenantId,
      connectorCredentialKey(connectorId),
      result.credentialToSave,
      tx,
    );
  if (result.revokeEventCredential)
    await input.deps.secrets.delete(tenantId, connectorEventCredentialKey(connectorId), tx);
  else if (result.eventCredentialToSave !== undefined)
    await input.deps.secrets.put(
      tenantId,
      connectorEventCredentialKey(connectorId),
      result.eventCredentialToSave,
      tx,
    );
}

export async function persistConnectorConfiguration(
  input: SavePersistenceInput,
): Promise<string | null> {
  await lockConnectorLifecycle(input.tx, input.tenantId, input.connectorId);
  const current = await currentConnector(input);
  // Retrying a prepared save updates only the same tenant-owned connector, never a second row.
  if (input.creating && input.body.setupId && current) input = { ...input, creating: false };
  if (!input.creating && !current) return 'data source not found';
  if (await singletonConflict(input)) return 'this connector supports one tenant utility only';
  const initial: ProviderSaveResult = {
    settings:
      (input.parsedGitLabSettings as unknown as Record<string, unknown> | null) ??
      requestObject(input.body.settings) ??
      {},
    ...(input.credential ? { credentialToSave: input.credential } : {}),
  };
  const outcome = providerSaveHandlers[input.type]
    ? await providerSaveHandlers[input.type]!(input, current, initial)
    : initial;
  if (typeof outcome === 'string') return outcome;
  if (input.type === 'gitlab') {
    const token = input.body.issueCredential;
    if (
      token !== undefined &&
      (typeof token !== 'string' || !token.trim() || token.length > 16_384)
    )
      return 'invalid GitLab issue-write credential';
    const policy = issueManagement(outcome.settings);
    const old = requestObject(current?.settings);
    const identityChanged =
      old &&
      (old.baseUrl !== outcome.settings.baseUrl ||
        String(old.groupId ?? '') !== String(outcome.settings.groupId ?? '') ||
        String(old.projectId ?? '') !== String(outcome.settings.projectId ?? ''));
    if (policy.enabled && identityChanged && !token)
      return 'provide a new issue-write credential when the GitLab target changes';
    if (
      policy.enabled &&
      !token &&
      !(await input.deps.secrets.get(
        input.tenantId,
        connectorIssueCredentialKey(input.connectorId),
        input.tx,
      ))
    )
      return 'an issue-write credential with api scope is required';
    if (!policy.enabled || identityChanged)
      await input.deps.secrets.delete(
        input.tenantId,
        connectorIssueCredentialKey(input.connectorId),
        input.tx,
      );
    if (policy.enabled && typeof token === 'string')
      await input.deps.secrets.put(
        input.tenantId,
        connectorIssueCredentialKey(input.connectorId),
        token.trim(),
        input.tx,
      );
  }
  await persistRecord(input, current, outcome);
  return null;
}
