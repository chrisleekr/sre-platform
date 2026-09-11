// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../theme';

const session = vi.hoisted(() => ({
  foundingId: 'founding-1',
  getCredentials: vi.fn().mockResolvedValue({ kind: 'cookie' }),
}));

vi.mock('../../auth', () => ({ useSession: () => session }));

import { WorkspaceChecklist } from '../WorkspaceChecklist';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  session.getCredentials.mockClear();
});

test('dismisses the dashboard checklist and refreshes server state', async () => {
  const onRefresh = vi.fn();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ dismissed: true }));
  render(
    <ThemeProvider>
      <MemoryRouter>
        <WorkspaceChecklist
          checklist={{ workspaceCreated: true, domainVerified: false }}
          domainId="domain-1"
          onRefresh={onRefresh}
        />
      </MemoryRouter>
    </ThemeProvider>,
  );

  expect(screen.getByRole('link', { name: 'Verify domain' }).getAttribute('href')).toBe(
    '/w/settings/domains/domain-1',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss checklist' }));

  await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringMatching(/\/me\/welcome\/dismiss$/),
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-onboarding-founding-id': 'founding-1' }),
    }),
  );
});
