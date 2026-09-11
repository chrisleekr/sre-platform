import type { ConnectorConfig } from '../../../registry';
import type { HostLookup } from '../../../ssrf';
import {
  makeKubernetesConnector as realMakeKubernetesConnector,
  probeKubernetes as realProbeKubernetes,
} from '../connector';

export const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfakepem\n-----END CERTIFICATE-----';

// Every read path SSRF-validates the apiUrl by resolving it, so tests must inject a resolver or
// they reach real DNS. A public address keeps the default (non-allowPrivate) checks satisfied too.
export const lookup: HostLookup = async () => ['93.184.216.34'];

// Stamped at load, i.e. ~now, so the client-side window filter keeps it whenever the suite runs.
export const recentIso = new Date().toISOString();

export const podsResp = {
  items: [
    {
      metadata: { name: 'checkout-abc', namespace: 'checkout' },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'app',
            ready: false,
            restartCount: 2,
            lastState: {
              terminated: {
                reason: 'OOMKilled',
                exitCode: 137,
                finishedAt: '2026-08-17T05:43:23Z',
              },
            },
            state: { running: {} },
          },
          {
            name: 'sidecar',
            ready: true,
            restartCount: 7,
            state: { waiting: { reason: 'CrashLoopBackOff' } },
          },
        ],
      },
    },
  ],
};

export const eventsResp = {
  items: [
    {
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      involvedObject: { kind: 'Pod', name: 'checkout-abc' },
      lastTimestamp: recentIso,
    },
  ],
};

export const nodesResp = {
  items: [
    {
      metadata: { name: 'ip-10-0-0-5' },
      status: {
        conditions: [
          { type: 'Ready', status: 'False' },
          { type: 'MemoryPressure', status: 'True' },
          { type: 'DiskPressure', status: 'False' },
        ],
      },
    },
  ],
};

export type Tls = { ca?: string; rejectUnauthorized?: boolean };

/** A fake fetch routing by URL path, recording each call's auth header and safety options. */
export function fakeFetch(
  routes: {
    pods?: unknown;
    events?: unknown;
    nodes?: unknown;
    status?: Partial<{ pods: number; events: number; nodes: number }>;
  } = {},
) {
  const calls: {
    url: string;
    auth?: string;
    tls?: Tls;
    hasSignal: boolean;
    redirect?: string;
  }[] = [];
  const impl = (async (
    url: string,
    init?: { headers?: Record<string, string>; tls?: Tls; signal?: unknown; redirect?: string },
  ) => {
    const u = String(url);
    calls.push({
      url: u,
      auth: init?.headers?.Authorization,
      tls: init?.tls,
      hasSignal: init?.signal != null,
      redirect: init?.redirect,
    });
    const pick = (): { status: number; body: unknown } => {
      if (u.includes('/pods'))
        return { status: routes.status?.pods ?? 200, body: routes.pods ?? podsResp };
      if (u.includes('/events'))
        return { status: routes.status?.events ?? 200, body: routes.events ?? eventsResp };
      return { status: routes.status?.nodes ?? 200, body: routes.nodes ?? nodesResp };
    };
    const { status, body } = pick();
    return { ok: status < 400, status, json: async () => body };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

export function cfg(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    tenantId: 't1',
    type: 'kubernetes',
    settings: { apiUrl: 'https://k8s.example.com:6443' },
    getCredential: async () => 'k8s-sa-token',
    ...overrides,
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    name: overrides.name ?? 'Test Kubernetes',
  };
}

export function probeFetch(status: { api?: number; pods?: number; secrets?: number }) {
  return (async (url: string) => {
    const value = String(url);
    let responseStatus: number;
    if (value.includes('/secrets')) responseStatus = status.secrets ?? 200;
    else if (value.includes('/pods')) responseStatus = status.pods ?? 200;
    else responseStatus = status.api ?? 200;
    return {
      ok: responseStatus < 400,
      status: responseStatus,
      json: async () => ({}),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
}

// Wrappers, not plain re-exports: they default the injected resolver so no test reaches real DNS.
// A test that exercises SSRF validation itself passes its own resolver and overrides the default.
export const makeKubernetesConnector: typeof realMakeKubernetesConnector = (
  config,
  fetchImpl,
  hostLookup = lookup,
) => realMakeKubernetesConnector(config, fetchImpl, hostLookup);

export const probeKubernetes: typeof realProbeKubernetes = (
  config,
  fetchImpl,
  hostLookup = lookup,
) => realProbeKubernetes(config, fetchImpl, hostLookup);

export type { ConnectorConfig, HostLookup };
