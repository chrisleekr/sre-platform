import { describe, expect, test, vi } from 'vitest';
import { discoveryFetch, gitLabDiscoveryFailure, GitLabDiscoveryError } from '../discovery-failure';

const url = 'https://gitlab.example.com/api/v4/groups/platform';
describe('GitLab discovery diagnostics', () => {
  test.each([
    [401, 'authentication'],
    [403, 'permission'],
    [404, 'not_found'],
    [400, 'invalid_response'],
  ] as const)('does not retry HTTP %s or expose its body', async (status, code) => {
    const fetchImpl = vi.fn(
      async () => new Response('glpat-secret and private provider details', { status }),
    );
    const error = await discoveryFetch(fetchImpl as unknown as typeof fetch)(url).catch(
      (error) => error,
    );
    expect(error).toMatchObject({ code, stage: 'group', upstreamStatus: status });
    expect(error.message).not.toContain('glpat-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  test('retries a temporary failure, retaining authentication and redirect restrictions', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}'));
    const response = await discoveryFetch(fetchImpl as unknown as typeof fetch)(url, {
      headers: { 'PRIVATE-TOKEN': 'secret' },
      redirect: 'error',
    });
    expect(response.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      headers: { 'PRIVATE-TOKEN': 'secret' },
      redirect: 'error',
    });
    expect(fetchImpl.mock.calls[0]?.[1].signal).not.toBe(fetchImpl.mock.calls[1]?.[1].signal);
  });
  test('bounds retries across catalog pages, not once per page', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}'))
      .mockImplementation(async () => new Response('', { status: 503 }));
    const request = discoveryFetch(fetchImpl as unknown as typeof fetch);
    await request(url);
    await expect(request(url + '/projects')).rejects.toMatchObject({
      code: 'unavailable',
      stage: 'projects',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  test.each([null, '120', 'invalid', new Date(Date.now() + 60000).toUTCString()])(
    'does not retry a rate limit before the allowed time (%s)',
    async (retryAfter) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response('', {
            status: 429,
            headers: retryAfter ? { 'retry-after': retryAfter } : {},
          }),
      );
      await expect(discoveryFetch(fetchImpl as unknown as typeof fetch)(url)).rejects.toMatchObject(
        {
          code: 'rate_limit',
        },
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  test('honors a short retry-after', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0.3' } }))
      .mockResolvedValueOnce(new Response('{}'));
    const start = Date.now();
    await discoveryFetch(fetchImpl as unknown as typeof fetch)(url);
    expect(Date.now() - start).toBeGreaterThanOrEqual(290);
  });
  test.each([new DOMException('sensitive', 'TimeoutError'), new TypeError('sensitive')])(
    'bounds transport retries and redacts their errors',
    async (failure) => {
      const fetchImpl = vi.fn(async () => {
        throw failure;
      });
      const error = await discoveryFetch(fetchImpl as unknown as typeof fetch)(url).catch(
        (error) => error,
      );
      expect(error.code).toBe(failure.name === 'TimeoutError' ? 'timeout' : 'network');
      expect(error.message).not.toContain('sensitive');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    },
  );
  test('does not spend retry budget on optional version discovery', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    await expect(
      discoveryFetch(fetchImpl as unknown as typeof fetch)(
        'https://gitlab.example.com/api/v4/version',
      ),
    ).rejects.toMatchObject({ stage: 'version' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  test('only returns safe diagnostics for unexpected and bounded-response failures', () => {
    expect(gitLabDiscoveryFailure(new Error('private token')).code).toBe('unknown');
    expect(gitLabDiscoveryFailure(new Error('gitlab api response exceeds byte limit')).code).toBe(
      'response_limit',
    );
    expect(gitLabDiscoveryFailure(new SyntaxError('secret response')).code).toBe(
      'invalid_response',
    );
    const error = new GitLabDiscoveryError('permission', 'group', 403);
    expect(gitLabDiscoveryFailure(error)).toBe(error);
  });
});
