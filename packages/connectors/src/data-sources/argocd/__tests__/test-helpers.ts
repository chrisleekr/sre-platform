import type { ConnectorConfig } from '../../../registry';
import type { HostLookup } from '../../../ssrf';
import type { ConnectorTool } from '../../../types';
import { buildGetUrl, makeArgoCdConnector } from '../index';

export interface Call {
  url: string;
  method: string;
  authorization?: string;
  accept?: string;
  redirect?: string;
  tls?: { ca?: string; rejectUnauthorized?: boolean };
  hasSignal: boolean;
}

export interface Resp {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

/** A fake fetch; records auth header, tls, and safety options per call, and serves json or text. */
export function fakeFetch(handler?: (url: string) => Resp) {
  const calls: Call[] = [];
  const impl = (async (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      signal?: unknown;
      redirect?: string;
      tls?: Call['tls'];
    },
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      authorization: headers.Authorization,
      accept: headers.Accept,
      redirect: init?.redirect,
      tls: init?.tls,
      hasSignal: init?.signal != null,
    });
    const r = handler?.(String(url)) ?? {};
    const status = r.status ?? (r.ok === false ? 500 : 200);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A public IP so the SSRF guard admits the default test host. */
export const lookup: HostLookup = async () => ['93.184.216.34'];

export function cfg(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  const { settings, ...rest } = overrides;
  return {
    tenantId: 't1',
    type: 'argocd',
    settings: {
      account: 'sre-platform',
      baseUrl: 'https://argocd.example.com',
      applicationsInAnyNamespace: false,
      applications: [{ project: 'payments', name: 'checkout' }],
      ...settings,
    },
    getCredential: async () => 'token-abc',
    ...rest,
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    name: overrides.name ?? 'Test Argo CD',
  };
}

export function conn(
  fetchImpl: ReturnType<typeof fakeFetch>['impl'],
  overrides: Partial<ConnectorConfig> = {},
) {
  return makeArgoCdConnector(cfg(overrides), fetchImpl, lookup);
}

export function multiCfg(accessRole?: string): ConnectorConfig {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test Argo CD',
    tenantId: 't1',
    type: 'argocd',
    settings: {
      baseUrl: 'https://argocd.example.com',
      ...(accessRole ? { accessRole } : {}),
      applicationsInAnyNamespace: false,
      projects: [
        { project: 'payments', applications: [{ name: 'checkout' }] },
        { project: 'identity', applications: [{ name: 'login' }] },
      ],
    },
    getCredential: async () =>
      JSON.stringify({
        version: 1,
        tokens: [
          { project: 'payments', token: 'payments-token' },
          { project: 'identity', token: 'identity-token' },
        ],
      }),
  };
}

export function apiConn(
  fetchImpl: ReturnType<typeof fakeFetch>['impl'],
  applicationsInAnyNamespace = false,
  labelSelector?: string,
) {
  return conn(fetchImpl, {
    settings: {
      applicationsInAnyNamespace,
      applications: [
        {
          project: 'default',
          name: 'api',
          ...(applicationsInAnyNamespace ? { namespace: 'team-a' } : {}),
        },
      ],
      ...(labelSelector ? { labelSelector } : {}),
    },
  });
}

export function scopedApplication(namespace = 'argocd') {
  return {
    metadata: { name: 'api', namespace, uid: 'uid-api' },
    spec: { project: 'default' },
    status: {},
  };
}

export function scopedFetch(response: Resp, namespace = 'argocd') {
  return fakeFetch((url) =>
    new URL(url).pathname === '/api/v1/applications/api'
      ? { json: scopedApplication(namespace) }
      : response,
  );
}

export function toolNamed(c: ReturnType<typeof makeArgoCdConnector>, name: string): ConnectorTool {
  const t = c.tools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

export { buildGetUrl, makeArgoCdConnector };
export type { ConnectorConfig, ConnectorTool, HostLookup };
