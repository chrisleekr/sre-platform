// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setImpersonationSession } from '../../lib/impersonation';

const mocks = vi.hoisted(() => ({
  request: vi.fn(async () => ({ ended: true })),
  invalidate: vi.fn(),
}));

vi.mock('../../auth', () => ({
  useSession: () => ({
    getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
    sessionKey: 'session-a',
  }),
}));
vi.mock('../../admin/api', () => ({ adminRequest: mocks.request }));
vi.mock('../../lib/me-store', () => ({ invalidateMe: mocks.invalidate }));

import { ImpersonationBanner } from '../ImpersonationBanner';

afterEach(() => {
  cleanup();
  setImpersonationSession(null);
  vi.clearAllMocks();
});

describe('ImpersonationBanner', () => {
  test('identifies the workspace, counts down, and ends the server session', async () => {
    setImpersonationSession({
      id: '12345678-1111-4111-8111-111111111111',
      tenantId: '12345678-2222-4222-8222-222222222222',
      tenantName: 'Acme Engineering',
      reason: 'Diagnose customer authentication failures',
      expiresAt: new Date(Date.now() + 65_000).toISOString(),
    });
    render(
      <MemoryRouter initialEntries={['/w']}>
        <Routes>
          <Route path="/w" element={<ImpersonationBanner />} />
          <Route path="/admin" element={<p>Admin control room</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/Viewing Acme Engineering as a platform administrator/)).toBeDefined();
    expect(screen.getByText(/1:0[45]/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'End now' }));

    await waitFor(() => expect(screen.getByText('Admin control room')).toBeDefined());
    expect(mocks.request).toHaveBeenCalledWith(
      expect.any(Function),
      '/impersonation/12345678-1111-4111-8111-111111111111/end',
      { method: 'POST' },
    );
    expect(mocks.invalidate).toHaveBeenCalledWith('session-a');
  });
});
