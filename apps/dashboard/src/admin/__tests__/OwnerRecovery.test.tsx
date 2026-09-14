// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { OwnerRecovery } from '../OwnerRecovery';

const mocks = vi.hoisted(() => ({
  credentials: async () => ({ kind: 'bearer' as const, token: 'test-token' }),
  invalidate: vi.fn(),
}));
vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: mocks.credentials, sessionKey: 'ownership-session' }),
}));
vi.mock('../../lib/me-store', () => ({ invalidateMe: mocks.invalidate }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const workspace = {
  id: 'workspace',
  name: 'Acme',
  slug: 'acme',
  ownership: { inactiveOwnerCount: 0 },
};

test('reports that recovery requires an existing active member when none is eligible', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ members: [] })),
  );
  render(<OwnerRecovery workspace={workspace} onRecovered={async () => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: 'Recover owner' }));
  await screen.findByText(/No active members have active accounts/);
  expect(screen.queryByRole('button', { name: 'Review recovery' })).toBeNull();
});

test('requires review, reason and exact workspace confirmation before submitting the selected member', async () => {
  const saved = vi.fn();
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      saved(JSON.parse(String(init.body)));
      return Response.json({ role: 'owner' });
    }
    return Response.json({
      members: [{ userId: 'member-id', email: 'member@example.test', role: 'member' }],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const refreshed = vi.fn(async () => undefined);
  render(
    <OwnerRecovery
      workspace={{ ...workspace, ownership: { inactiveOwnerCount: 1 } }}
      onRecovered={refreshed}
    />,
  );
  expect(screen.getByText(/Existing inactive owners keep their grants/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Recover owner' }));
  await screen.findByLabelText('New owner');
  fireEvent.change(screen.getByLabelText('New owner'), { target: { value: 'member-id' } });
  fireEvent.change(screen.getByLabelText('Recovery reason'), {
    target: { value: 'Verified legacy ownership' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review recovery' }));
  expect(
    screen.getByRole('heading', { name: 'Make member@example.test the owner of Acme?' }),
  ).toBeDefined();
  expect(saved).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('button', { name: 'Confirm change' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Type acme to confirm'), { target: { value: 'acme' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
  await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  expect(saved).toHaveBeenCalledExactlyOnceWith({
    userId: 'member-id',
    reason: 'Verified legacy ownership',
  });
  expect(mocks.invalidate).toHaveBeenCalledWith('ownership-session');
});

test('shows a failed candidate load and permits an explicit retry', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ error: 'Administrator access was revoked' }, { status: 403 }),
    ),
  );
  render(<OwnerRecovery workspace={workspace} onRecovered={async () => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: 'Recover owner' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Administrator access was revoked',
  );
  expect(
    (screen.getByRole('button', { name: 'Recover owner' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test('two workspace confirmations each announce their own exact target', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        members: [{ userId: 'member-id', email: 'member@example.test', role: 'member' }],
      }),
    ),
  );
  render(
    <>
      <OwnerRecovery workspace={workspace} onRecovered={async () => undefined} />
      <OwnerRecovery
        workspace={{ ...workspace, id: 'other', name: 'Beta', slug: 'beta' }}
        onRecovered={async () => undefined}
      />
    </>,
  );
  for (const button of screen.getAllByRole('button', { name: 'Recover owner' }))
    fireEvent.click(button);
  await waitFor(() => expect(screen.getAllByLabelText('New owner')).toHaveLength(2));
  for (const select of screen.getAllByLabelText('New owner'))
    fireEvent.change(select, { target: { value: 'member-id' } });
  for (const reason of screen.getAllByLabelText('Recovery reason'))
    fireEvent.change(reason, { target: { value: 'Verified ownership' } });
  for (const button of screen.getAllByRole('button', { name: 'Review recovery' }))
    fireEvent.click(button);
  const first = screen.getByRole('alertdialog', {
    name: 'Make member@example.test the owner of Acme?',
  });
  const second = screen.getByRole('alertdialog', {
    name: 'Make member@example.test the owner of Beta?',
  });
  expect(first.getAttribute('aria-labelledby')).not.toBe(second.getAttribute('aria-labelledby'));
});
