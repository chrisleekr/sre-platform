// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../theme';

const mocks = vi.hoisted(() => ({
  status: 'unauthenticated' as 'authenticated' | 'unauthenticated',
  sessionKey: undefined as string | undefined,
  foundingId: undefined as string | undefined,
  getCredentials: vi.fn(),
  me: {
    data: null as Record<string, unknown> | null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  },
}));
vi.mock('../../auth', () => ({ useSession: () => mocks }));
vi.mock('../../lib/me-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/me-store')>()),
  useMe: () => mocks.me,
}));
import { VerifyDomainPage } from '../VerifyDomainPage';

afterEach(() => {
  expect(document.body.textContent ?? '').not.toMatch(
    /\b(?:tenant|founding|binding|membership)\b/i,
  );
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  mocks.getCredentials.mockReset();
  mocks.foundingId = undefined;
  mocks.status = 'unauthenticated';
  mocks.sessionKey = undefined;
  mocks.me.data = null;
  mocks.me.refresh.mockReset();
});

function themed(children: ReactNode) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe('domain verification', () => {
  test('shows the DNS proof, copies its value, and exposes a polite manual check', async () => {
    const onCheck = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      themed(
        <MemoryRouter>
          <VerifyDomainPage
            domain={{
              id: 'domain-1',
              domain: 'example.test',
              status: 'pending',
              challengeHost: '_sre-platform.example.test',
              challengeValue: 'verification-value',
              lastCheckedAt: null,
            }}
            onCheck={onCheck}
          />
        </MemoryRouter>,
      ),
    );
    expect(screen.getByText('_sre-platform.example.test')).toBeDefined();
    expect(screen.getByText('verification-value')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /copy value/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('verification-value'));
    expect(screen.getByRole('status').textContent).toMatch(/copied/i);
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    expect(onCheck).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  test('announces clipboard failure with a manual fallback', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(
      themed(
        <MemoryRouter>
          <VerifyDomainPage
            domain={{
              id: 'domain-1',
              domain: 'example.test',
              status: 'pending',
              challengeHost: '_sre-platform.example.test',
              challengeValue: 'verification-value',
              lastCheckedAt: null,
            }}
          />
        </MemoryRouter>,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /copy value/i }));
    expect(await screen.findByText(/select the value and copy it manually/i)).toBeDefined();
  });
});
