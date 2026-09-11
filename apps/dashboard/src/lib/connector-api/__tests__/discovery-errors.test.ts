import { afterEach, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../../authenticatedFetch';
import { discoverGitHubInstallations } from '../github';
import { discoverGitLabProjects } from '../gitlab';

vi.mock('../../authenticatedFetch', () => ({ authenticatedFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const requests = {
  github: () => discoverGitHubInstallations('https://api.example.test', vi.fn(), { appId: '1' }),
  gitlab: () =>
    discoverGitLabProjects('https://api.example.test', vi.fn(), {
      baseUrl: 'https://gitlab.example.test',
      groupPath: 'platform',
    }),
};

test.each(Object.entries(requests))(
  '%s never trusts a gateway error body',
  async (_provider, request) => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      Response.json({ error: 'private provider diagnostics', code: '__proto__' }, { status: 502 }),
    );
    const error = await request().catch((cause) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain('private provider diagnostics');
  },
);

test.each([
  ['github', 'provider_unavailable', 'GitHub is unavailable.'],
  ['gitlab', 'network', 'The SRE Platform API could not connect to GitLab.'],
] as const)('%s maps documented codes to local instructions', async (provider, code, expected) => {
  vi.mocked(authenticatedFetch).mockResolvedValue(
    Response.json({ code, error: 'private provider diagnostics' }, { status: 503 }),
  );
  await expect(requests[provider]()).rejects.toThrow(expected);
});
