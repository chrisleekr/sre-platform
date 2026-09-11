import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import * as connectorExports from '@sre/connectors';
import { makeGitHubConnector, type ConnectorConfig, type HostLookup } from '@sre/connectors';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
const publicLookup: HostLookup = async () => ['140.82.121.4'];

function splitConfig(): ConnectorConfig {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Acceptance GitHub',
    tenantId: 'tenant-github-acceptance',
    type: 'github',
    settings: {
      appId: 'Iv1.acceptance',
      installationId: 101,
      repo: 'acme/payments',
      service: 'payments',
    },
    getCredential: async () => privateKey,
  };
}

function legacyConfig(): ConnectorConfig {
  return {
    ...splitConfig(),
    getCredential: async () =>
      JSON.stringify({ appId: 'Iv1.acceptance', installationId: 101, privateKey }),
  };
}

function response(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '42',
      'x-ratelimit-reset': '1787356800',
      ...extraHeaders,
    },
  });
}

describe('GitHub connector lifecycle acceptance start state', () => {
  test('exports bounded App installation discovery', () => {
    const exports = connectorExports as unknown as Record<string, unknown>;
    expect(exports.discoverGitHubInstallations).toBeTypeOf('function');
  });

  test('exports granted-repository discovery', () => {
    const exports = connectorExports as unknown as Record<string, unknown>;
    expect(exports.discoverGitHubRepositories).toBeTypeOf('function');
  });

  test('preserves GitHub inactive as a canonical deployment status', () => {
    const exports = connectorExports as unknown as Record<string, unknown>;
    expect(exports.DEPLOY_STATUSES).toEqual(expect.arrayContaining(['inactive']));
  });

  test('maps deployments and their latest statuses into investigation snapshots', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/app/installations/101/access_tokens')) {
        return response(
          { token: 'ghs-installation-only', expires_at: '2026-08-22T02:00:00Z' },
          201,
        );
      }
      if (url.includes('/deployments/9001/statuses')) {
        return response([
          {
            id: 5001,
            state: 'inactive',
            creator: { login: 'release-bot' },
            log_url: 'https://github.com/acme/payments/actions/runs/5001',
            environment_url: 'https://payments.example.com',
            created_at: '2026-08-22T00:02:00Z',
            updated_at: '2026-08-22T00:03:00Z',
          },
        ]);
      }
      if (url.includes('/repos/acme/payments/deployments')) {
        return response([
          {
            id: 9001,
            ref: 'main',
            sha: '0123456789abcdef0123456789abcdef01234567',
            environment: 'production',
            creator: { login: 'release-bot' },
            created_at: '2026-08-22T00:01:00Z',
            updated_at: '2026-08-22T00:03:00Z',
          },
        ]);
      }
      return response({ message: 'unexpected path' }, 404);
    }) as typeof fetch;

    const snapshots = await makeGitHubConnector(splitConfig(), fetchImpl, publicLookup).snapshot();

    expect(calls.some((url) => url.includes('/repos/acme/payments/deployments'))).toBe(true);
    expect(calls.some((url) => url.includes('/deployments/9001/statuses'))).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      source: 'github',
      entityId: '9001',
      metadata: {
        providerId: '9001',
        repo: 'acme/payments',
        environment: 'production',
        actor: 'release-bot',
        sha: '0123456789abcdef0123456789abcdef01234567',
        status: 'inactive',
      },
    });
  });

  test('requires Deployments read permission before verification can enable polling', async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/app/installations/101/access_tokens')) {
        return response(
          { token: 'ghs-installation-only', expires_at: '2026-08-22T02:00:00Z' },
          201,
        );
      }
      if (url.includes('/installation/repositories')) return response({ repositories: [] });
      if (url.includes('/repos/acme/payments/deployments')) return response({}, 403);
      return response({}, 404);
    }) as typeof fetch;

    const result = await makeGitHubConnector(legacyConfig(), fetchImpl, publicLookup).probe();

    expect(result).toMatchObject({
      status: 'unhealthy',
      reachable: true,
      authorized: true,
      checks: { canReadRepository: true, canReadDeployments: false },
      failureCategory: 'permission_denied',
    });
  });
});
