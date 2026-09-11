import { afterEach, expect, test, vi } from 'vitest';
import { discoverGitLabProjects, GitLabDiscoveryRequestError } from '../gitlab';
import { authenticatedFetch } from '../../authenticatedFetch';
vi.mock('../../authenticatedFetch', () => ({ authenticatedFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

test('preserves safe API diagnostics through the client boundary', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        error: 'private provider diagnostics',
        code: 'permission',
        reference: '00000000-0000-4000-8000-000000000007',
      }),
      { status: 502 },
    ),
  );
  const error = await discoverGitLabProjects('https://api.example.com', vi.fn(), {
    baseUrl: 'https://gitlab.example.com',
    groupPath: 'platform',
    credential: 'private-token',
  }).catch((error) => error);
  expect(error).toBeInstanceOf(GitLabDiscoveryRequestError);
  expect(error.message).toContain(
    'GitLab denied access. Check read_api scope and Reporter access to the group. Diagnostic reference:',
  );
  expect(error.message).not.toContain('private provider diagnostics');
  expect(error.message).not.toContain('private-token');
});

test('handles a non-JSON gateway failure without displaying its body', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(
    new Response('private gateway details', { status: 502 }),
  );
  await expect(
    discoverGitLabProjects('https://api.example.com', vi.fn(), {
      baseUrl: 'https://gitlab.example.com',
      groupPath: 'platform',
    }),
  ).rejects.toThrow('Discovery could not complete. Check your connection and retry.');
});
