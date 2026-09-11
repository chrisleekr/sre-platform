import { generateKeyPairSync } from 'node:crypto';
import type { ConnectorConfig } from '../../../registry';
import type { HostLookup } from '../../../ssrf';
import {
  githubCredentialBundle,
  githubSmeeUrl,
  makeInstallationTokenProvider,
  probeMint,
  resolveCreds,
  signAppJwt,
} from '../auth';
import {
  buildGetUrl,
  discoverGitHubInstallations,
  discoverGitHubRepositories,
  makeGitHubConnector,
} from '../index';

// A real RSA keypair in GitHub's default PKCS#1 PEM format, so signAppJwt exercises the true path.
export const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}) as unknown as { privateKey: string };

export const CRED = JSON.stringify({
  appId: 'Iv1.appclientid',
  privateKey: PEM,
  installationId: 4242,
});
export const V2_CRED = githubCredentialBundle(PEM, 'github-webhook-secret-test');
export const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

export interface Call {
  url: string;
  method: string;
  authorization?: string;
  accept?: string;
  apiVersion?: string;
  redirect?: string;
  body?: string;
}
export interface Reply {
  status: number;
  json?: unknown;
  text?: string;
  location?: string;
  link?: string;
  rateRemaining?: number;
  rateReset?: number;
}

export function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function makeFetch(handler: (url: string, init: RequestInit) => Reply): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.Authorization,
      accept: headers.Accept,
      apiVersion: headers['X-GitHub-Api-Version'],
      redirect: init.redirect,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const r = handler(url, init);
    const h = new Headers();
    if (r.location) h.set('location', r.location);
    if (r.link) h.set('link', r.link);
    if (r.rateRemaining !== undefined) h.set('x-ratelimit-remaining', String(r.rateRemaining));
    if (r.rateReset !== undefined) h.set('x-ratelimit-reset', String(r.rateReset));
    if (r.json !== undefined) h.set('content-type', 'application/json');
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
    return new Response(text, { status: r.status, headers: h });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Auto-answers runtime installation metadata and token mint, delegating other URLs to `routes`. */
export function withMint(
  routes: (url: string, init: RequestInit) => Reply,
  permissions: Record<string, 'read' | 'write'> = { contents: 'read', deployments: 'read' },
) {
  return (url: string, init: RequestInit): Reply => {
    if (/\/app\/installations\/[^/]+$/.test(url)) return { status: 200, json: { permissions } };
    if (url.includes('/access_tokens'))
      return { status: 201, json: { token: 'ghs_tok', expires_at: FUTURE } };
    return routes(url, init);
  };
}

export const publicLookup: HostLookup = async () => ['140.82.112.3'];

export function cfg(
  settings: Record<string, unknown> = { repo: 'octo/app' },
  credential = CRED,
): ConnectorConfig {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test GitHub',
    tenantId: 't1',
    type: 'github',
    settings,
    getCredential: async () => credential,
  };
}

export function v2cfg(settings: Record<string, unknown> = {}): ConnectorConfig {
  return cfg({ appId: 'Iv1.appclientid', installationId: 4242, ...settings }, V2_CRED);
}

export {
  buildGetUrl,
  discoverGitHubInstallations,
  discoverGitHubRepositories,
  githubCredentialBundle,
  githubSmeeUrl,
  makeGitHubConnector,
  makeInstallationTokenProvider,
  probeMint,
  resolveCreds,
  signAppJwt,
};
export type { ConnectorConfig, HostLookup };
