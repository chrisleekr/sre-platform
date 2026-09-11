import * as z from 'zod';
import type { ConnectorConfig } from '../../../registry';
import type { HostLookup } from '../../../ssrf';
import type { IDataSourceConnector } from '../../../types';
import {
  buildApiUrl,
  discoverGitLabGroup,
  discoverGitLabProjects,
  makeGitLabConnector,
} from '../index';

/** Hermetic resolver: every host maps to a public IP so tests never hit live DNS. */
export const publicLookup: HostLookup = async () => ['93.184.216.34'];

export const commitsResp = [
  {
    short_id: 'abc1234',
    title: 'fix cart total',
    author_name: 'Dev A',
    created_at: '2026-07-01T00:00:00Z',
    web_url: 'https://gl/c/abc1234',
  },
];
export const pipelinesResp = [
  {
    id: 42,
    status: 'failed',
    ref: 'main',
    sha: 'deadbeefcafe1234',
    source: 'push',
    updated_at: '2026-07-01T00:05:00Z',
    web_url: 'https://gl/p/42',
  },
];
export const deploymentsResp = [
  {
    id: 42,
    status: 'failed',
    ref: 'main',
    sha: 'deadbeefcafe1234',
    created_at: '2026-07-01T00:04:00Z',
    updated_at: '2026-07-01T00:05:00Z',
    user: { username: 'deploy-bot' },
    environment: { name: 'production' },
    deployable: { pipeline: { web_url: 'https://gl/p/42' } },
  },
];

/** A fake fetch routing by URL, recording each call's URL, token header, and safety options. */
export function fakeFetch(
  routes: { commits?: unknown; pipelines?: unknown; deployments?: unknown; fail?: boolean } = {},
) {
  const calls: { url: string; token?: string; hasSignal: boolean; redirect?: string }[] = [];
  const impl = (async (
    url: string,
    init?: { headers?: Record<string, string>; signal?: unknown; redirect?: string },
  ) => {
    calls.push({
      url: String(url),
      token: init?.headers?.['PRIVATE-TOKEN'],
      hasSignal: init?.signal != null,
      redirect: init?.redirect,
    });
    if (routes.fail) return new Response('{}', { status: 500 });
    const body = String(url).includes('/repository/commits')
      ? (routes.commits ?? commitsResp)
      : String(url).includes('/deployments')
        ? (routes.deployments ?? deploymentsResp)
        : (routes.pipelines ?? pipelinesResp);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

export function cfg(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    tenantId: 't1',
    type: 'gitlab',
    settings: {},
    getCredential: async () => 'glpat-token',
    ...overrides,
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    name: overrides.name ?? 'Test GitLab',
  };
}

export function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export { buildApiUrl, discoverGitLabGroup, discoverGitLabProjects, makeGitLabConnector, z };
export type { ConnectorConfig, HostLookup, IDataSourceConnector };
