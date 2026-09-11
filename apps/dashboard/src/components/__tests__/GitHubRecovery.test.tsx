// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GitHubConnectWizard, type GitHubConnectWizardProps } from '../GitHubConnectWizard';
import { installDialogMethods } from '../../test/dialog';
import { prepareTestDelivery } from '../../test/connector-delivery';

let dialog: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialog = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialog.restore();
});
function props(overrides: Partial<GitHubConnectWizardProps> = {}): GitHubConnectWizardProps {
  return {
    mode: 'edit',
    connectorId: '00000000-0000-4000-8000-000000000007',
    apiBaseUrl: 'https://api.example.com',
    initialSettings: {
      appId: 'Iv1.saved',
      appSlug: 'saved-app',
      installationId: '42',
      eventTransport: 'direct',
    },
    initialWebhookPath: '/webhooks/github/saved',
    eventFailureCategory: 'signature_mismatch',
    onStartManifest: vi.fn(),
    onCompleteManifest: vi.fn(),
    onPrepareDelivery: prepareTestDelivery,
    onDiscoverInstallations: vi.fn(async () => [
      {
        id: 42,
        accountLogin: 'acme',
        accountType: 'Organization',
        repositorySelection: 'all' as const,
        permissions: { contents: 'read' as const },
        writePermissions: [],
      },
    ]),
    onSave: vi.fn(async () => ({
      connectorId: '00000000-0000-4000-8000-000000000007',
      name: 'GitHub',
    })),
    onRunTest: vi.fn(async () => ({
      status: 'healthy' as const,
      reachable: true,
      authorized: true,
      warnings: [],
      enabled: true,
    })),
    onClose: vi.fn(),
    ...overrides,
  };
}
async function review() {
  fireEvent.click(screen.getByRole('button', { name: 'Check current installation' }));
  await screen.findByText('Choose the installed account');
  fireEvent.click(screen.getByRole('button', { name: 'Review repository coverage' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review connection' }));
}

test('repairs only the webhook secret without resubmitting a private key or changing App identity', async () => {
  const input = props();
  render(<GitHubConnectWizard {...input} />);
  expect(screen.getByText(/Last delivery failed signature validation/)).toBeDefined();
  expect((screen.getByLabelText('Replacement webhook secret') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Replacement webhook secret'), {
    target: { value: 'replacement-webhook-secret' },
  });
  await review();
  expect(screen.getByText('Keep saved key')).toBeDefined();
  expect(screen.getByText('Replace on save; update GitHub to match')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Save, sync, and verify' }));
  await screen.findByText('GitHub code access verified and repository catalog synchronized.');
  expect(input.onDiscoverInstallations).toHaveBeenCalledWith({
    dataSourceId: input.connectorId,
    appId: 'Iv1.saved',
  });
  expect(input.onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      id: input.connectorId,
      webhookSecret: 'replacement-webhook-secret',
      settings: expect.objectContaining({ appId: 'Iv1.saved', installationId: '42' }),
    }),
  );
  expect(vi.mocked(input.onSave).mock.calls[0]?.[0]).not.toHaveProperty('credential');
  expect(
    screen.getByText(/Event health becomes verified after the first signed delivery/),
  ).toBeDefined();
});

test('replaces a revoked key, keeps the webhook secret, and allows editing after failed verification', async () => {
  const input = props({
    onRunTest: vi.fn(async () => ({
      status: 'unhealthy' as const,
      reachable: true,
      authorized: false,
      warnings: ['Authentication rejected'],
      enabled: false,
    })),
  });
  render(<GitHubConnectWizard {...input} />);
  fireEvent.click(screen.getByText('Replace private key for API access'));
  fireEvent.change(screen.getByLabelText('Replacement private key (PEM)'), {
    target: { value: 'replacement-private-key' },
  });
  await review();
  fireEvent.click(screen.getByRole('button', { name: 'Save, sync, and verify' }));
  await screen.findByText('GitHub saved but verification failed.');
  expect(vi.mocked(input.onSave).mock.calls[0]?.[0]).toMatchObject({
    credential: 'replacement-private-key',
  });
  expect(vi.mocked(input.onSave).mock.calls[0]?.[0]).not.toHaveProperty('webhookSecret');
  expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Edit configuration' }));
  expect(screen.getByLabelText('Replacement private key (PEM)')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Keep saved private key' }));
  expect(
    (screen.getByLabelText('Replacement private key (PEM)') as HTMLTextAreaElement).value,
  ).toBe('');
});

test('rejects a short replacement secret without clearing it or contacting GitHub', () => {
  const input = props();
  render(<GitHubConnectWizard {...input} />);
  fireEvent.change(screen.getByLabelText('Replacement webhook secret'), {
    target: { value: 'short' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Check current installation' }));
  expect(screen.getByRole('alert').textContent).toContain('at least 16 characters');
  expect(input.onDiscoverInstallations).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep saved webhook secret' }));
  expect((screen.getByLabelText('Replacement webhook secret') as HTMLInputElement).value).toBe('');
});

test('corrects the Smee channel while leaving saved credentials unchanged', async () => {
  const input = props({
    apiBaseUrl: 'http://localhost:43000',
    initialSettings: {
      appId: 'Iv1.saved',
      installationId: '42',
      eventTransport: 'smee',
      smeeConfigured: true,
    },
  });
  render(<GitHubConnectWizard {...input} />);
  fireEvent.change(screen.getByLabelText('Smee channel URL'), {
    target: { value: 'https://smee.io/replacement-channel' },
  });
  await review();
  fireEvent.click(screen.getByRole('button', { name: 'Save, sync, and verify' }));
  await screen.findByText('GitHub code access verified and repository catalog synchronized.');
  expect(vi.mocked(input.onSave).mock.calls[0]?.[0]).toMatchObject({
    settings: { smeeUrl: 'https://smee.io/replacement-channel' },
  });
  expect(vi.mocked(input.onSave).mock.calls[0]?.[0]).not.toHaveProperty('webhookSecret');
  expect(vi.mocked(input.onSave).mock.calls[0]?.[0]).not.toHaveProperty('credential');
  expect(screen.getByText(/relay connection is not confirmed/)).toBeDefined();
});
