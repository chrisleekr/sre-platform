// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ScimProvisioningSetting } from '../ScimProvisioningSetting';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

test('enables SCIM with an explicit match policy and exposes the token once', async () => {
  const save = vi.fn(async () => ({ token: 'one-time-token' }));
  render(
    <ScimProvisioningSetting
      providerId="provider-1"
      subjectClaim="employee_id"
      enabled={false}
      requireProvisioned={false}
      identityAttribute="externalId"
      tokenCreatedAt={null}
      tokenExpiresAt={null}
      save={save}
      loadAccounts={vi.fn()}
    />,
  );

  fireEvent.change(screen.getByLabelText(/match oidc employee_id to/i), {
    target: { value: 'userName' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /require a provisioned account/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Enable SCIM' }));

  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      { enabled: true, requireProvisioned: true, identityAttribute: 'userName' },
      true,
    ),
  );
  expect(await screen.findByText('one-time-token')).toBeDefined();
  expect(screen.getByText(/will not be shown again/i)).toBeDefined();
});

test('shows the endpoint and current accounts and supports policy, rotation, and disable', async () => {
  const save = vi.fn(async () => ({}));
  const loadAccounts = vi.fn(async () => ({
    total: 1,
    accounts: [
      {
        id: 'account-1',
        userName: 'sre@example.test',
        externalId: 'employee-42',
        active: true,
        updatedAt: '2026-09-06T00:00:00.000Z',
      },
    ],
  }));
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

  render(
    <ScimProvisioningSetting
      providerId="provider-1"
      subjectClaim="sub"
      enabled
      requireProvisioned
      identityAttribute="externalId"
      tokenCreatedAt="2026-09-01T00:00:00.000Z"
      tokenExpiresAt="2027-03-01T00:00:00.000Z"
      save={save}
      loadAccounts={loadAccounts}
    />,
  );

  expect(await screen.findByText('sre@example.test')).toBeDefined();
  expect(screen.getByText('employee-42')).toBeDefined();
  expect(loadAccounts).toHaveBeenCalledWith(1, 20);
  fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
  expect(writeText).toHaveBeenCalledWith('http://localhost:43000/scim/v2/providers/provider-1');

  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }), false),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Rotate token' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Rotate token' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }), true),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Disable SCIM' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Disable SCIM' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      { enabled: false, requireProvisioned: false, identityAttribute: 'externalId' },
      false,
    ),
  );
});

test('falls back to manual copy guidance when clipboard access is unavailable', async () => {
  Reflect.deleteProperty(navigator, 'clipboard');
  render(
    <ScimProvisioningSetting
      providerId="provider-1"
      subjectClaim="sub"
      enabled
      requireProvisioned={false}
      identityAttribute="externalId"
      tokenCreatedAt={null}
      tokenExpiresAt={null}
      save={vi.fn()}
      loadAccounts={vi.fn(async () => ({ total: 0, accounts: [] }))}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
  expect(await screen.findByText('Select and copy the value manually.')).toBeDefined();
});
