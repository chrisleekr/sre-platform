// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';
import { LocalDevelopmentSession } from '../LocalDevelopmentSession';
import { getLocalSession, setLocalSession } from '../local-session';
import { clearSessionFailure, reportSessionFailure } from '../session-failure';

vi.mock('../lib/application-session', () => ({
  useApplicationSession: () => ({ isLoading: false, isAuthenticated: false }),
}));
vi.mock('../local-session', async (original) => ({
  ...(await original<typeof import('../local-session')>()),
  localLoginCapabilities: async () => ({ localPasswordLogin: false, localDevelopmentLogin: true }),
}));
let requests = 0;
beforeEach(() => {
  vi.useFakeTimers();
  requests = 0;
  setLocalSession({ token: 'initial', email: 'dev@example.com', expiresAt: Date.now() + 4_000 });
  clearSessionFailure();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        token: `token-${++requests}`,
        email: 'dev@example.com',
        expiresAt: Date.now() + 4_000,
      }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
async function mount() {
  render(
    <StrictMode>
      <LocalDevelopmentSession>
        <h1>Normal entry or workspace</h1>
      </LocalDevelopmentSession>
    </StrictMode>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
test('an empty tab renders normal sign-in without an automatic session or mode controls', async () => {
  setLocalSession(null);
  await mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(requests).toBe(0);
  expect(screen.getByRole('heading', { name: 'Normal entry or workspace' })).toBeTruthy();
  expect(screen.queryByLabelText('Development mode')).toBeNull();
});
test('existing sessions renew before expiry', async () => {
  await mount();
  expect(requests).toBe(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(requests).toBe(1);
  expect(getLocalSession()?.token).toBe('token-1');
});
test('recovers one rejected session, but stops if the replacement is rejected too', async () => {
  await mount();
  await act(async () => {
    reportSessionFailure('unauthorized');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(requests).toBe(1);
  await act(async () => {
    reportSessionFailure('unauthorized');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(requests).toBe(1);
  expect(screen.getByRole('status').textContent).toContain('API rejected the renewed');
  fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(requests).toBe(2);
});
test('sign-out stops renewal without a separate pause flag', async () => {
  await mount();
  await act(async () => {
    setLocalSession(null);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(requests).toBe(0);
});
test('an unavailable API retries an existing expired session', async () => {
  setLocalSession({ token: 'expired', email: 'dev@example.com', expiresAt: 1 });
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('API restarting'));
  await mount();
  expect(screen.getByRole('status').textContent).toContain('API restarting');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screen.getByRole('heading', { name: 'Normal entry or workspace' })).toBeTruthy();
});
