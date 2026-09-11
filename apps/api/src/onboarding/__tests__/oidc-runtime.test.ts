import { expect, test, vi } from 'vitest';
const discover = vi.hoisted(() => vi.fn());
vi.mock('../oidc-discovery', () => ({ discoverOidcProvider: discover }));
import { makeOidcRuntime } from '../oidc-runtime';
test('discovery delegates to the guarded transport and exposes no browser token operation', async () => {
  discover.mockResolvedValue({ issuer: 'https://directory.example' });
  const runtime = makeOidcRuntime();
  await expect(runtime.discover('https://directory.example')).resolves.toEqual({
    issuer: 'https://directory.example',
  });
  expect(discover).toHaveBeenCalledWith('https://directory.example', {
    fetchJson: expect.any(Function),
  });
  expect(Object.keys(runtime)).toEqual(['discover']);
});
