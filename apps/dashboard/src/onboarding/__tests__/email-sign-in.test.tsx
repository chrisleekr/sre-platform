// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../theme';
import { SignInPage } from '../SignInPage';
import { rememberFounderSignIn } from '../../lib/founder-sign-in';

const h = vi.hoisted(() => ({ loginLocally: vi.fn(), signInWith: vi.fn(), retrySignIn: vi.fn() }));
vi.mock('../../auth', () => ({ useSession: () => h }));
vi.mock('../usePublicConfig', () => ({
  usePublicConfig: () => ({ value: { registrationMode: 'open' } }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  sessionStorage.clear();
});

function entry() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/sign-in']}>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/get-started" element={<h1>Create workspace</h1>} />
          <Route path="/w/select" element={<h1>Your workspace</h1>} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

test('the authenticated founder can return through email before domain verification', async () => {
  rememberFounderSignIn({
    email: 'founder@example.test',
    providerId: 'provider',
    foundingId: 'setup',
    expiresAt: Date.now() + 60000,
  });
  h.loginLocally.mockResolvedValue(false);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  entry();
  fireEvent.change(screen.getByLabelText('Work email'), {
    target: { value: 'FOUNDER@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await act(async () => {});
  expect(h.retrySignIn).toHaveBeenCalledWith({
    providerId: 'provider',
    foundingId: 'setup',
    returnTo: '/w/select',
  });
  expect(fetch).not.toHaveBeenCalled();
});

test('a different email cannot reuse the remembered founder route', async () => {
  rememberFounderSignIn({
    email: 'founder@example.test',
    providerId: 'provider',
    foundingId: 'setup',
    expiresAt: Date.now() + 60000,
  });
  h.loginLocally.mockResolvedValue(false);
  const fetch = vi.fn(async () => Response.json({ kind: 'unknown' }));
  vi.stubGlobal('fetch', fetch);
  entry();
  fireEvent.change(screen.getByLabelText('Work email'), {
    target: { value: 'other@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText(/We could not find company sign-in/);
  expect(h.retrySignIn).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
});

test('the configured dev email uses Continue without company discovery or a password form', async () => {
  h.loginLocally.mockResolvedValue(true);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  entry();
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'dev@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Your workspace' });
  expect(h.loginLocally).toHaveBeenCalledWith('dev@example.com', expect.any(AbortSignal));
  expect(fetch).not.toHaveBeenCalled();
  expect(document.querySelector('input[type=password]')).toBeNull();
});

test('leaving a pending email submission cancels it without company discovery or navigation back', async () => {
  let finish!: (result: boolean) => void;
  h.loginLocally.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  entry();
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'dev@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  const signal = h.loginLocally.mock.calls[0]![1] as AbortSignal;
  fireEvent.click(screen.getByRole('link', { name: 'Create a workspace' }));
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(false);
  });
  expect(screen.getByRole('heading', { name: 'Create workspace' })).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  expect(h.signInWith).not.toHaveBeenCalled();
});
