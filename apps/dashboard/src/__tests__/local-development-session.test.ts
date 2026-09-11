// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});
const session = () => ({
  token: 'token',
  email: 'dev@example.com',
  expiresAt: Date.now() + 900_000,
});
function stubFetch(matched = true) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    Response.json(
      String(url).endsWith('/capabilities')
        ? { localDevelopmentLogin: true }
        : matched
          ? session()
          : { matched: false },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
test('selects the local account by email without a password', async () => {
  const fetch = stubFetch();
  const { signInLocalDevelopment } = await import('../local-development-session');
  expect(await signInLocalDevelopment('', 'dev@example.com')).toBe(true);
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ email: 'dev@example.com' });
  const { getLocalSession } = await import('../local-session');
  expect(getLocalSession()?.email).toBe('dev@example.com');
});
test('unmatched emails continue to company sign-in without a local session', async () => {
  stubFetch(false);
  const { signInLocalDevelopment } = await import('../local-development-session');
  expect(await signInLocalDevelopment('', 'person@example.com')).toBe(false);
  const { getLocalSession } = await import('../local-session');
  expect(getLocalSession()).toBeNull();
});
test('disabled capability never calls the passwordless endpoint', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ localDevelopmentLogin: false }));
  vi.stubGlobal('fetch', fetch);
  const { signInLocalDevelopment } = await import('../local-development-session');
  expect(await signInLocalDevelopment('', 'dev@example.com')).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('an empty tab cannot renew into a new session', async () => {
  const fetch = stubFetch();
  const { renewLocalDevelopmentSession } = await import('../local-development-session');
  expect(await renewLocalDevelopmentSession('')).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

test('normal renewal preserves the cached workspace projection', async () => {
  stubFetch();
  const { setLocalSession } = await import('../local-session');
  const { loadMe, invalidateMe } = await import('../lib/me-store');
  invalidateMe(null);
  const load = vi.fn().mockResolvedValue({ state: 'active' });
  setLocalSession(session());
  await loadMe(load, 'local:dev@example.com');
  const { renewLocalDevelopmentSession } = await import('../local-development-session');
  await renewLocalDevelopmentSession('');
  await loadMe(load, 'local:dev@example.com');
  expect(load).toHaveBeenCalledTimes(1);
});

test('aborting an initial email submission prevents session installation', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.endsWith('/capabilities')
        ? Promise.resolve(Response.json({ localDevelopmentLogin: true }))
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    ),
  );
  const { signInLocalDevelopment } = await import('../local-development-session');
  const controller = new AbortController();
  const pending = signInLocalDevelopment('', 'dev@example.com', controller.signal);
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  finish(Response.json(session()));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const { getLocalSession } = await import('../local-session');
  expect(getLocalSession()).toBeNull();
});
test('concurrent renewals share one request for the existing email', async () => {
  const fetch = stubFetch();
  const { setLocalSession } = await import('../local-session');
  setLocalSession(session());
  const { renewLocalDevelopmentSession } = await import('../local-development-session');
  await Promise.all([renewLocalDevelopmentSession(''), renewLocalDevelopmentSession('')]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('a pending renewal cannot sign back in after sign-out', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.endsWith('/capabilities')
        ? Promise.resolve(Response.json({ localDevelopmentLogin: true }))
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    ),
  );
  const { setLocalSession, getLocalSession } = await import('../local-session');
  setLocalSession(session());
  const { renewLocalDevelopmentSession } = await import('../local-development-session');
  const request = renewLocalDevelopmentSession('');
  await vi.waitFor(() => expect(finish).toBeDefined());
  setLocalSession(null);
  finish(Response.json(session()));
  expect(await request).toBe(false);
  expect(getLocalSession()).toBeNull();
});
test('an expired stored session retains its email so it can recover after reload', async () => {
  sessionStorage.setItem('sre.localSession', JSON.stringify({ ...session(), expiresAt: 1 }));
  const { getLocalSession } = await import('../local-session');
  expect(getLocalSession()?.email).toBe('dev@example.com');
});
test('failed renewal can retry, but account mismatch cannot install a session', async () => {
  const fetch = stubFetch();
  const { setLocalSession } = await import('../local-session');
  setLocalSession(session());
  const { renewLocalDevelopmentSession } = await import('../local-development-session');
  await renewLocalDevelopmentSession('');
  fetch.mockRejectedValueOnce(new TypeError('API restarting'));
  await expect(renewLocalDevelopmentSession('')).rejects.toThrow('API restarting');
  fetch.mockResolvedValueOnce(Response.json({ matched: false }));
  await expect(renewLocalDevelopmentSession('')).rejects.toThrow('account changed');
});
