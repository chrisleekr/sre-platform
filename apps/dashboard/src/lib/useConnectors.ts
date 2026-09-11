import { checkResponse } from './request-error';
import type { CredentialGetter } from './request-credentials';
import { useCallback, useState } from 'react';
import type {
  ConnectorSummary,
  ConnectorTestResult,
  KubernetesSettings,
  KubernetesTestResult,
  PrometheusSettings,
} from './connectors';
import { authenticatedFetch } from './authenticatedFetch';
import { useFetchResource } from './useFetchResource';

export interface UseConnectors {
  connectors: ConnectorSummary[];
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

const selectConnectors = (body: unknown): ConnectorSummary[] =>
  (body as { connectors: ConnectorSummary[] }).connectors;

/**
 * Fetch the tenant's configured connectors (the access token authorizes + scopes them). One-shot GET
 * plus a `refetch` so the panel reloads after a save or test flips a connector's state.
 */
export function useConnectors(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
}): UseConnectors {
  // Bumping the nonce re-runs the load effect; refetch() drives the post-mutation reload.
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const { data, loading, error } = useFetchResource<ConnectorSummary[]>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: '/connectors',
    initial: [],
    select: selectConnectors,
    nonce,
  });
  return { connectors: data, loading, error, refetch };
}

function connectorMutationUrl(apiBaseUrl: string, type: string, id?: string): string {
  return `${apiBaseUrl}/connectors/${type}${id ? `/${encodeURIComponent(id)}` : ''}`;
}

/**
 * Upsert the Kubernetes connector (settings + encrypted credential). The wizard saves with
 * `enabled:false`; the test-connection probe flips it true server-side only on a healthy probe.
 */
export async function saveKubernetesConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: {
    id?: string;
    name: string;
    settings: KubernetesSettings;
    credential?: string;
    enabled: boolean;
  },
): Promise<{ connectorId: string }> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'kubernetes', body.id),
    getCredentials,
    {
      method: body.id ? 'PUT' : 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: body.name,
        settings: body.settings,
        ...(body.credential ? { credential: body.credential } : {}),
        enabled: body.enabled,
      }),
    },
  );
  await checkResponse(res, 'The connection could not be saved. Review its status and retry.');
  return (await res.json()) as { connectorId: string };
}

/** GET the least-privilege RBAC manifest (YAML text) for the given install namespace + SA. */
export async function fetchKubernetesManifest(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  params: { namespace: string; serviceAccount: string },
): Promise<string> {
  const query = new URLSearchParams({
    namespace: params.namespace,
    serviceAccount: params.serviceAccount,
  });
  const res = await authenticatedFetch(
    `${apiBaseUrl}/connectors/kubernetes/manifest?${query.toString()}`,
    getCredentials,
  );
  await checkResponse(res, 'The access manifest could not be loaded. Retry.');
  return res.text();
}

/** Probe the saved Kubernetes connector; a pass flips `enabled` server-side. Throws on any non-2xx. */
export async function testKubernetesConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<KubernetesTestResult> {
  const res = await authenticatedFetch(
    `${connectorMutationUrl(apiBaseUrl, 'kubernetes', id)}/test`,
    getCredentials,
    { method: 'POST' },
  );
  await checkResponse(res, 'Verification could not complete. Refresh the connection and retry.');
  return (await res.json()) as KubernetesTestResult;
}

export async function disconnectKubernetesConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<void> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'kubernetes', id),
    getCredentials,
    {
      method: 'DELETE',
    },
  );
  await checkResponse(
    res,
    'Disconnect could not be confirmed. Refresh the connection before retrying.',
  );
}

export async function savePrometheusConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: {
    id?: string;
    setupId?: string;
    name: string;
    settings: PrometheusSettings;
    credential?: string;
    eventToken?: string;
    insecureTlsAcknowledged?: boolean;
    insecureHttpAcknowledged?: boolean;
  },
): Promise<{
  connectorId: string;
  webhookPath?: string;
  relayStatus?: 'connected' | 'stopped' | 'failed';
}> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'prometheus', body.id),
    getCredentials,
    {
      method: body.id ? 'PUT' : 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, id: undefined, enabled: false }),
    },
  );
  await checkResponse(res, 'The connection could not be saved. Review its status and retry.');
  return (await res.json()) as {
    connectorId: string;
    webhookPath?: string;
    relayStatus?: 'connected' | 'stopped' | 'failed';
  };
}

export async function saveStatusCakeConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  body: { id?: string; name: string; credential?: string },
): Promise<{ connectorId: string }> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, 'statuscake', body.id),
    getCredentials,
    {
      method: body.id ? 'PUT' : 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ settings: {}, ...body, id: undefined, enabled: false }),
    },
  );
  await checkResponse(res, 'The connection could not be saved. Review its status and retry.');
  return (await res.json()) as { connectorId: string };
}

async function testConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  type: 'prometheus' | 'statuscake' | 'datadog' | 'grafana',
  id: string,
): Promise<ConnectorTestResult> {
  const res = await authenticatedFetch(
    `${connectorMutationUrl(apiBaseUrl, type, id)}/test`,
    getCredentials,
    { method: 'POST' },
  );
  await checkResponse(res, 'Verification could not complete. Refresh the connection and retry.');
  return (await res.json()) as ConnectorTestResult;
}

export const testPrometheusConnector = (
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<ConnectorTestResult> => testConnector(apiBaseUrl, getCredentials, 'prometheus', id);

export const testStatusCakeConnector = (
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<ConnectorTestResult> => testConnector(apiBaseUrl, getCredentials, 'statuscake', id);

export async function saveObservabilityConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  type: 'datadog' | 'grafana',
  body: {
    id?: string;
    name: string;
    settings: Record<string, unknown>;
    credential?: string;
    insecureTlsAcknowledged?: boolean;
    insecureHttpAcknowledged?: boolean;
  },
): Promise<{ connectorId: string }> {
  const res = await authenticatedFetch(
    connectorMutationUrl(apiBaseUrl, type, body.id),
    getCredentials,
    {
      method: body.id ? 'PUT' : 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, id: undefined, enabled: false }),
    },
  );
  await checkResponse(res, 'The connection could not be saved. Review its status and retry.');
  return (await res.json()) as { connectorId: string };
}

export const testObservabilityConnector = (
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  type: 'datadog' | 'grafana',
  id: string,
): Promise<ConnectorTestResult> => testConnector(apiBaseUrl, getCredentials, type, id);

async function disconnectConnector(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  type: 'prometheus' | 'statuscake' | 'datadog' | 'grafana',
  id: string,
): Promise<void> {
  const res = await authenticatedFetch(connectorMutationUrl(apiBaseUrl, type, id), getCredentials, {
    method: 'DELETE',
  });
  await checkResponse(
    res,
    'Disconnect could not be confirmed. Refresh the connection before retrying.',
  );
}

export const disconnectPrometheusConnector = (
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<void> => disconnectConnector(apiBaseUrl, getCredentials, 'prometheus', id);

export const disconnectStatusCakeConnector = (
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  id: string,
): Promise<void> => disconnectConnector(apiBaseUrl, getCredentials, 'statuscake', id);

export const disconnectObservabilityConnector = (
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  type: 'datadog' | 'grafana',
  id: string,
): Promise<void> => disconnectConnector(apiBaseUrl, getCredentials, type, id);

export * from './connector-api/argocd';
export * from './connector-api/github';
export * from './connector-api/gitlab';
