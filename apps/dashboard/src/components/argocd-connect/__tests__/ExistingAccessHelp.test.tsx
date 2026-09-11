// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ArgoCdExistingAccessHelp } from '../ExistingAccessHelp';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('shows project lookup before a role is entered, then copies the exact role token command', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { rerender } = render(<ArgoCdExistingAccessHelp project="payments" role="" />);
  fireEvent.click(screen.getByText('How to find the existing role and token for payments'));
  expect(screen.getByText("argocd proj role list 'payments'")).toBeDefined();
  expect(screen.queryByText(/argocd proj role create-token/)).toBeNull();

  rerender(<ArgoCdExistingAccessHelp project="payments" role="incident-reader" />);
  expect(screen.getByText("argocd proj role get 'payments' 'incident-reader'")).toBeDefined();
  fireEvent.click(
    screen.getByRole('button', { name: 'Copy payments existing-role token command' }),
  );
  expect(writeText).toHaveBeenCalledWith(
    "argocd proj role create-token 'payments' 'incident-reader' --expires-in 8760h --token-only",
  );
  expect(screen.getByText(/Argo CD cannot retrieve a lost token/)).toBeDefined();
  expect(screen.getByText(/does not renew it automatically/)).toBeDefined();

  rerender(<ArgoCdExistingAccessHelp project="billing" role="other-reader" />);
  expect(screen.getByText("argocd proj role get 'billing' 'other-reader'")).toBeDefined();
  expect(screen.queryByText(/argocd.*payments/)).toBeNull();
});

test.each(["bad'; touch injected", '$(whoami)', '--help', '*', 'a'.repeat(64)])(
  'does not generate token commands for an invalid role: %s',
  (role) => {
    render(<ArgoCdExistingAccessHelp project="payments" role={role} />);
    expect(screen.queryByText(/argocd proj role create-token/)).toBeNull();
    expect(screen.queryByText(/argocd proj role get/)).toBeNull();
  },
);

test('does not generate commands for an invalid project', () => {
  render(<ArgoCdExistingAccessHelp project="bad'; touch injected" role="reader" />);
  expect(screen.queryByText(/argocd proj role/)).toBeNull();
});

test('generated-access role checks are visible without duplicating token creation', () => {
  render(<ArgoCdExistingAccessHelp project="payments" role="reader" showTokenCreation={false} />);
  expect(screen.getByRole('button', { name: 'Copy payments role list command' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Copy payments role details command' })).toBeDefined();
  expect(screen.queryByText(/argocd proj role create-token/)).toBeNull();
  expect(screen.getByText(/A stored token is not proof/)).toBeDefined();
  expect(screen.queryByText(/Enter its name in Existing project role name/)).toBeNull();
});
