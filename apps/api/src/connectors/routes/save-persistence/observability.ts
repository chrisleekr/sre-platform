import {
  alertmanagerEventCredential,
  alertmanagerEventToken,
  alertmanagerSmeeUrl,
} from '@sre/connectors';
import { connectorCredentialKey, connectorEventCredentialKey } from '@sre/db';
import {
  parseDatadogCredential,
  parseDatadogSettings,
  parseGrafanaSettings,
  parsePrometheusCredential,
  parsePrometheusSettings,
  requestObject,
  smeeUrlInput,
} from '../../helpers';
import type { ProviderSaveHandler } from './contracts';

export const savePrometheus: ProviderSaveHandler = async (input, current, initial) => {
  const {
    tx,
    deps,
    tenantId,
    connectorId,
    body,
    credential,
    submittedEventToken,
    parsedPrometheusSettings,
  } = input;
  const savedSettings = parsePrometheusSettings(current?.settings);
  const requestedSettings = parsedPrometheusSettings!;
  const rawRequestedSettings = requestObject(body.settings)!;
  const settings = (!Object.prototype.hasOwnProperty.call(rawRequestedSettings, 'caCert') &&
  savedSettings?.caCert
    ? { ...requestedSettings, caCert: savedSettings.caCert }
    : requestedSettings) as unknown as Record<string, unknown>;
  const savedCredential = await deps.secrets.get(tenantId, connectorCredentialKey(connectorId), tx);
  const submittedCredential = credential ? parsePrometheusCredential(credential) : null;
  if (credential && !submittedCredential) return 'invalid Prometheus credential';
  const credentialType = submittedCredential
    ? requestObject(JSON.parse(submittedCredential))?.type
    : undefined;
  if (credentialType && credentialType !== requestedSettings.authType)
    return 'Prometheus credential does not match the selected authentication method';
  if (
    !submittedCredential &&
    requestedSettings.authType !== 'none' &&
    (!savedCredential || savedSettings?.authType !== requestedSettings.authType)
  )
    return 'a credential is required for the selected Prometheus authentication method';
  const credentialToSave =
    submittedCredential ??
    (requestedSettings.authType === 'none' ? JSON.stringify({ type: 'none' }) : undefined);
  const savedEventCredential = await deps.secrets.get(
    tenantId,
    connectorEventCredentialKey(connectorId),
    tx,
  );
  const submittedSmeeUrl = smeeUrlInput(rawRequestedSettings.smeeUrl);
  if (rawRequestedSettings.smeeUrl !== undefined && !submittedSmeeUrl)
    return 'invalid Alertmanager Smee channel URL';
  const eventToken =
    submittedEventToken ?? alertmanagerEventToken(savedEventCredential) ?? undefined;
  const smeeUrl =
    requestedSettings.eventTransport === 'smee'
      ? (submittedSmeeUrl ?? alertmanagerSmeeUrl(savedEventCredential) ?? undefined)
      : undefined;
  if (requestedSettings.eventTransport !== 'none' && !eventToken)
    return 'an Alertmanager bearer token is required when event delivery is enabled';
  if (requestedSettings.eventTransport === 'smee' && !smeeUrl)
    return 'a Smee channel URL is required for local Alertmanager delivery';
  return {
    ...initial,
    settings,
    ...(credentialToSave !== undefined ? { credentialToSave } : {}),
    ...(requestedSettings.eventTransport === 'none'
      ? { revokeEventCredential: true }
      : eventToken
        ? { eventCredentialToSave: alertmanagerEventCredential(eventToken, smeeUrl) }
        : {}),
  };
};

export const saveStatusCake: ProviderSaveHandler = async (input, _current, initial) => {
  const { tx, deps, tenantId, connectorId, credential } = input;
  const savedCredential = await deps.secrets.get(tenantId, connectorCredentialKey(connectorId), tx);
  if (!credential && !savedCredential) return 'credential is required';
  if (credential && credential.length > 8192) return 'credential is too large';
  if (credential && (credential.includes('\r') || credential.includes('\n')))
    return 'credential is invalid';
  return { ...initial, settings: {}, ...(credential ? { credentialToSave: credential } : {}) };
};

export const saveDatadog: ProviderSaveHandler = async (input, current, initial) => {
  const { tx, deps, tenantId, connectorId, credential, parsedDatadogSettings } = input;
  const savedCredential = await deps.secrets.get(tenantId, connectorCredentialKey(connectorId), tx);
  const savedSettings = parseDatadogSettings(current?.settings);
  const parsedCredential = credential ? parseDatadogCredential(credential) : null;
  if (credential && !parsedCredential) return 'invalid Datadog credential';
  if (!parsedCredential && !savedCredential) return 'credential is required';
  if (savedSettings && savedSettings.site !== parsedDatadogSettings!.site && !parsedCredential)
    return 'a new credential is required when the Datadog site changes';
  return {
    ...initial,
    settings: parsedDatadogSettings!,
    ...(parsedCredential ? { credentialToSave: parsedCredential } : {}),
  };
};

export const saveGrafana: ProviderSaveHandler = async (input, current, initial) => {
  const { tx, deps, tenantId, connectorId, body, credential, parsedGrafanaSettings } = input;
  const savedCredential = await deps.secrets.get(tenantId, connectorCredentialKey(connectorId), tx);
  const savedSettings = parseGrafanaSettings(current?.settings);
  const rawRequestedSettings = requestObject(body.settings)!;
  const requestedSettings = parsedGrafanaSettings!;
  const settings = (!Object.prototype.hasOwnProperty.call(rawRequestedSettings, 'caCert') &&
  savedSettings?.caCert
    ? { ...requestedSettings, caCert: savedSettings.caCert }
    : requestedSettings) as unknown as Record<string, unknown>;
  if (!credential && !savedCredential) return 'credential is required';
  if (savedSettings && savedSettings.baseUrl !== requestedSettings.baseUrl && !credential)
    return 'a new credential is required when the Grafana URL changes';
  if (credential && (credential.length > 64 * 1024 || /[\r\n]/.test(credential)))
    return 'invalid Grafana credential';
  return { ...initial, settings, ...(credential ? { credentialToSave: credential } : {}) };
};
