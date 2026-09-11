import { connectorConfigs, connectorCredentialKey } from '@sre/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { kubernetesAccessId, lockConnectorLifecycle, requestObject } from '../../helpers';
import type { ProviderSaveHandler } from './contracts';

export const saveKubernetes: ProviderSaveHandler = async (input, current, initial) => {
  const { tx, deps, tenantId, connectorId, creating, body, credential } = input;
  const savedSettings = requestObject(current?.settings);
  const requestedSettings = requestObject(body.settings);
  if (!requestedSettings) return 'invalid Kubernetes settings';
  const requestedAccessId = kubernetesAccessId(requestedSettings.accessId);
  if (requestedSettings.accessId !== undefined && !requestedAccessId)
    return 'invalid Kubernetes access ID';
  const savedAccessId = kubernetesAccessId(savedSettings?.accessId);
  let accessId: string | undefined;
  if (creating) {
    if (!requestedAccessId) return 'new Kubernetes data sources require a unique access ID';
    await lockConnectorLifecycle(tx, tenantId, `kubernetes-access-id:${requestedAccessId}`);
    const duplicate = await tx
      .select({ id: connectorConfigs.id })
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.type, 'kubernetes'),
          isNull(connectorConfigs.deletedAt),
          sql`${connectorConfigs.settings}->>'accessId' = ${requestedAccessId}`,
        ),
      )
      .limit(1);
    if (duplicate[0]) return 'this Kubernetes access ID is already used by another source';
    accessId = requestedAccessId;
  } else if (savedAccessId) {
    if (requestedAccessId && requestedAccessId !== savedAccessId)
      return 'the Kubernetes access ID cannot be changed; reconnect the data source instead';
    accessId = savedAccessId;
  } else if (requestedAccessId) {
    return 'a legacy Kubernetes access ID cannot be changed; reconnect the data source instead';
  }
  const credentialConfigured = await deps.secrets.has(
    tenantId,
    connectorCredentialKey(connectorId),
    tx,
  );
  if (!credential && !credentialConfigured) return 'credential is required';
  if (!credential && (!savedSettings || savedSettings.apiUrl !== requestedSettings.apiUrl))
    return 'a new credential is required when the Kubernetes API URL changes';
  const settings =
    !Object.prototype.hasOwnProperty.call(requestedSettings, 'caCert') &&
    typeof savedSettings?.caCert === 'string'
      ? { ...requestedSettings, ...(accessId ? { accessId } : {}), caCert: savedSettings.caCert }
      : { ...requestedSettings, ...(accessId ? { accessId } : {}) };
  return { ...initial, settings };
};
