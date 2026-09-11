// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { rememberReturnTo } from '../../local-session';
import { AuthCallback } from '../AuthCallback';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../lib/application-session', () => ({
  useApplicationSession: () => ({ complete: mocks.complete }),
}));

afterEach(() => {
  sessionStorage.clear();
  mocks.complete.mockReset();
  mocks.navigate.mockReset();
});

describe('AuthCallback', () => {
  test('completes once and replaces the route with the attempt destination', async () => {
    mocks.complete.mockResolvedValue({ returnTo: '/w/incidents/one' });

    render(<AuthCallback />);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/w/incidents/one', { replace: true }),
    );
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });

  test('returns a failed callback to login with the preserved recovery destination', async () => {
    rememberReturnTo('/w/topology');
    mocks.complete.mockRejectedValue(new Error('provider rejected callback'));

    render(<AuthCallback />);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/sign-in', {
        replace: true,
        state: { from: '/w/topology', recovery: true, error: 'provider rejected callback' },
      }),
    );
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });
});
