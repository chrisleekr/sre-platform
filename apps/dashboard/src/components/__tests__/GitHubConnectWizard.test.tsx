// @vitest-environment jsdom
import { useState } from 'react';
import { prepareTestDelivery } from '../../test/connector-delivery';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { installDialogMethods } from '../../test/dialog';
import { GitHubConnectWizard, type GitHubConnectWizardProps } from '../GitHubConnectWizard';
import { RequestError } from '../../lib/request-error';

let dialogMethods: ReturnType<typeof installDialogMethods>;

function props(overrides: Partial<GitHubConnectWizardProps> = {}): GitHubConnectWizardProps {
  return {
    onPrepareDelivery: prepareTestDelivery,
    mode: 'connect',
    apiBaseUrl: 'http://localhost:43000',
    onStartManifest: vi.fn(),
    onCompleteManifest: vi.fn(),
    onDiscoverInstallations: vi.fn(),
    onSave: vi.fn(),
    onRunTest: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  dialogMethods = installDialogMethods();
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('form[action^="https://github.com/"]').forEach((form) => form.remove());
  dialogMethods.restore();
  vi.restoreAllMocks();
});

describe('GitHubConnectWizard', () => {
  test('shows a copyable saved webhook on opening Manage, without discovery or saving', () => {
    const input = props({
      mode: 'edit',
      apiBaseUrl: 'https://api.example.com',
      initialSettings: { appId: '123', eventTransport: 'direct' },
      initialWebhookPath: '/webhooks/github/saved-key',
    });
    render(<GitHubConnectWizard {...input} />);
    expect(screen.queryByLabelText('SRE Platform API URL')).toBeNull();
    expect(screen.getByText('https://api.example.com/webhooks/github/saved-key')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy GitHub webhook URL' })).toBeDefined();
    expect(input.onSave).not.toHaveBeenCalled();
    expect(input.onDiscoverInstallations).not.toHaveBeenCalled();
  });

  test('prepares a webhook before saving and separates relay and API values', async () => {
    render(<GitHubConnectWizard {...props({ apiBaseUrl: 'https://api.example.com' })} />);
    fireEvent.click(screen.getByLabelText(/Public HTTPS API/));
    expect(screen.queryByLabelText('SRE Platform API URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy GitHub webhook URL' })).toBeNull();
    expect(
      await screen.findByText(
        'https://api.example.com/webhooks/github/00000000-0000-4000-8000-000000000099',
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByLabelText(/Smee relay/));
    fireEvent.change(screen.getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/private' },
    });
    fireEvent.click(screen.getByLabelText(/Public HTTPS API/));
    expect(screen.queryByLabelText('SRE Platform API URL')).toBeNull();
    expect(screen.queryByDisplayValue('https://smee.io/private')).toBeNull();
  });

  test('blocks public setup when deployment has no HTTPS API origin', () => {
    const input = props({
      mode: 'edit',
      apiBaseUrl: 'http://localhost:43000',
      initialSettings: { appId: '123', eventTransport: 'direct' },
      initialWebhookPath: '/webhooks/github/key',
    });
    render(<GitHubConnectWizard {...input} />);
    expect(screen.getByRole('alert').textContent).toContain('platform administrator');
    expect(screen.queryByRole('button', { name: 'Copy GitHub webhook URL' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check current installation' }));
    expect(input.onDiscoverInstallations).not.toHaveBeenCalled();
  });

  test('refuses an existing App with any provider write permission', async () => {
    const onSave = vi.fn();
    render(
      <GitHubConnectWizard
        {...props({
          onSave,
          onDiscoverInstallations: async () => [
            {
              id: 101,
              accountLogin: 'acme',
              accountType: 'Organization',
              repositorySelection: 'all',
              permissions: { contents: 'read', actions: 'read' },
              writePermissions: ['workflows'],
              appSlug: 'over-granted-app',
            },
          ],
        })}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Connect GitHub App' });
    expect(
      within(dialog).getByText(/App registration has one webhook URL and secret/i),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByLabelText(/Existing dedicated App/i));
    fireEvent.change(within(dialog).getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/first-class-sre' },
    });
    fireEvent.change(within(dialog).getByLabelText('GitHub App ID or client ID'), {
      target: { value: 'Iv1.test' },
    });
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), {
      target: { value: 'write-only-private-key' },
    });
    fireEvent.change(within(dialog).getByLabelText('Webhook secret'), {
      target: { value: 'webhook-secret-test' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check existing App' }));

    expect(await within(dialog).findByText(/Write access detected: workflows/i)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review repository coverage' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review connection' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/can write workflows/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'rejects issue writes without valid opt-in and repositories: %s',
    async (enabled) => {
      const input = props({
        onDiscoverInstallations: async () => [
          {
            id: 101,
            accountLogin: 'acme',
            accountType: 'Organization',
            repositorySelection: 'all',
            permissions: { contents: 'read', issues: 'write' },
            writePermissions: ['issues'],
            appSlug: 'issue-app',
          },
        ],
      });
      render(<GitHubConnectWizard {...input} />);
      fireEvent.click(screen.getByLabelText(/Existing dedicated App/i));
      fireEvent.change(screen.getByLabelText('Smee channel URL'), {
        target: { value: 'https://smee.io/issue-test' },
      });
      fireEvent.change(screen.getByLabelText('GitHub App ID or client ID'), {
        target: { value: 'Iv1.test' },
      });
      fireEvent.change(screen.getByLabelText('Private key (PEM)'), {
        target: { value: 'test-key' },
      });
      fireEvent.change(screen.getByLabelText('Webhook secret'), {
        target: { value: 'test-webhook-secret' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Check existing App' }));
      await screen.findByLabelText('Installation');
      fireEvent.click(screen.getByRole('button', { name: 'Review repository coverage' }));
      if (enabled) {
        fireEvent.click(screen.getByRole('checkbox', { name: 'Allow confirmed issue changes' }));
        fireEvent.change(screen.getByLabelText('Repositories allowed for issue changes'), {
          target: { value: '  \n  ' },
        });
      }
      fireEvent.click(screen.getByRole('button', { name: 'Review connection' }));
      expect(screen.getByRole('alert').textContent).toMatch(
        enabled ? /Select at least one repository/ : /can write issues/,
      );
      expect(screen.queryByRole('button', { name: 'Save, sync, and verify' })).toBeNull();
      expect(input.onSave).not.toHaveBeenCalled();
    },
  );

  test('shows the sanitized installation discovery reason returned by the API', async () => {
    const onDiscoverInstallations = vi.fn(async () => {
      throw new RequestError(
        'GitHub rejected this client/App ID and private key. Confirm the key was generated by the same GitHub App.',
        422,
      );
    });
    render(<GitHubConnectWizard {...props({ onDiscoverInstallations })} />);
    const dialog = screen.getByRole('dialog', { name: 'Connect GitHub App' });

    fireEvent.click(within(dialog).getByLabelText(/Existing dedicated App/i));
    fireEvent.change(within(dialog).getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/first-class-sre' },
    });
    fireEvent.change(within(dialog).getByLabelText('GitHub App ID or client ID'), {
      target: { value: 'Iv1.test' },
    });
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), {
      target: { value: 'write-only-private-key' },
    });
    fireEvent.change(within(dialog).getByLabelText('Webhook secret'), {
      target: { value: 'webhook-secret-test' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check existing App' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'GitHub rejected this client/App ID and private key. Confirm the key was generated by the same GitHub App.',
    );
  });

  test('starts the dedicated App manifest with installation-wide read permissions and signed events', async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const onStartManifest = vi.fn(async () => ({
      actionUrl: 'https://github.com/settings/apps/new?state=opaque-state',
      state: 'opaque-state',
      manifest: {
        default_permissions: { contents: 'read' },
        default_events: ['push'],
      },
      webhookUrl: 'https://smee.io/first-class-sre',
      localWebhookPath: '/webhooks/github/opaque-key',
      expiresAt: '2026-08-23T12:00:00Z',
    }));
    render(<GitHubConnectWizard {...props({ onStartManifest })} />);
    const dialog = screen.getByRole('dialog', { name: 'Connect GitHub App' });

    fireEvent.change(within(dialog).getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/first-class-sre' },
    });
    await waitFor(() => expect(screen.queryByText('Preparing your webhook address…')).toBeNull());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create dedicated GitHub App' }));

    await waitFor(() => expect(onStartManifest).toHaveBeenCalledTimes(1));
    expect(onStartManifest).toHaveBeenCalledWith({
      setupId: '00000000-0000-4000-8000-000000000099',
      name: 'GitHub',
      ownerType: 'personal',
      deliveryMode: 'smee',
      deliveryUrl: 'https://smee.io/first-class-sre',
      dashboardUrl: window.location.origin,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    const form = document.querySelector('form[action^="https://github.com/settings/apps/new"]');
    expect(form).not.toBeNull();
    expect((form!.querySelector('input[name="manifest"]') as HTMLInputElement).value).toContain(
      'default_permissions',
    );
  });

  test('shows that the saved connector manages its Smee relay without a restart', async () => {
    const onPrepareDelivery = vi.fn(prepareTestDelivery);
    const onCompleteManifest = vi.fn(async (_input: { code: string; state: string }) => ({
      connectorId: '00000000-0000-4000-8000-000000000001',
      name: 'GitHub',
      appId: '901',
      appSlug: 'sre-platform-acme',
      appUrl: 'https://github.com/apps/sre-platform-acme',
      installUrl: 'https://github.com/apps/sre-platform-acme/installations/new',
      eventTransport: 'smee' as const,
      localWebhookPath: '/webhooks/github/opaque-key',
      relayStatus: 'connected' as const,
    }));
    function CallbackWizard() {
      const [callback, setCallback] = useState<{ code: string; state: string } | undefined>({
        code: 'manifest-code',
        state: 'opaque-state',
      });
      return (
        <GitHubConnectWizard
          {...props({
            initialSettings: { appId: '', eventTransport: 'direct' },
            apiBaseUrl: 'https://api.example.com',
            manifestCallback: callback,
            onCompleteManifest: async (input) => {
              const completed = await onCompleteManifest(input);
              setCallback(undefined);
              return completed;
            },
            onPrepareDelivery,
          })}
        />
      );
    }
    render(<CallbackWizard />);

    expect(await screen.findByText('Dedicated App created and credentials stored.')).toBeDefined();
    expect(onPrepareDelivery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Public HTTPS API/));
    fireEvent.click(screen.getByLabelText(/Smee relay/));
    await waitFor(() =>
      expect((screen.getByLabelText('Smee channel URL') as HTMLInputElement).value).toBe(''),
    );
    expect(onPrepareDelivery).not.toHaveBeenCalled();
    expect(onCompleteManifest).toHaveBeenCalledWith({
      code: 'manifest-code',
      state: 'opaque-state',
    });
    expect(screen.getByText(/No separate command or restart is required/i)).toBeDefined();
    expect(screen.queryByText(/GITHUB_SMEE_URL=/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Install dedicated App' }).getAttribute('href')).toBe(
      'https://github.com/apps/sre-platform-acme/installations/new',
    );
  });
});
