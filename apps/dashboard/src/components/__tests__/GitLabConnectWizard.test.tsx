// @vitest-environment jsdom
import { prepareGitLabTestDelivery as prepareTestDelivery } from '../../test/connector-delivery';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { installDialogMethods } from '../../test/dialog';
import type { GitLabSettings } from '../../lib/connectors';
import { GitLabConnectWizard } from '../GitLabConnectWizard';

let dialogMethods: ReturnType<typeof installDialogMethods>;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  dialogMethods = installDialogMethods();
});

afterEach(() => {
  cleanup();
  dialogMethods.restore();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('GitLabConnectWizard', () => {
  test('uses deployment configuration for the saved public webhook without an API URL field', () => {
    const onSave = vi.fn();
    render(
      <GitLabConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="edit"
        apiBaseUrl="https://api.example.com"
        initialSettings={{ eventTransport: 'direct' }}
        initialWebhookPath="/webhooks/gitlab/saved-key"
        onDiscover={vi.fn()}
        onSave={onSave}
        onRunTest={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('https://api.example.com/webhooks/gitlab/saved-key')).toBeDefined();
    expect(screen.queryByLabelText('SRE Platform API URL')).toBeNull();
    expect(screen.getByLabelText('GitLab URL')).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
  });
  test('produces copyable Smee webhook setup without reducing group coverage', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const onSave = vi.fn(
      async (_body: {
        settings: GitLabSettings;
        credential?: string;
        webhookSigningToken?: string;
      }) => ({
        connectorId: '00000000-0000-4000-8000-000000000001',
        name: 'GitLab',
        webhookPath: '/webhooks/gitlab/opaque-key',
        relayStatus: 'connected' as const,
      }),
    );
    render(
      <GitLabConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        apiBaseUrl="http://localhost:43000"
        onDiscover={async () => ({
          group: {
            id: 7,
            name: 'Platform',
            fullPath: 'platform',
            webUrl: 'https://gitlab.example.com/groups/platform',
          },
          projects: [
            {
              id: 42,
              name: 'checkout',
              pathWithNamespace: 'platform/checkout',
              webUrl: 'https://gitlab.example.com/platform/checkout',
              archived: false,
            },
          ],
          instance: { version: '19.2.4', enterprise: false },
        })}
        onSave={onSave}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          warnings: [],
          checks: {
            canReadGroup: true,
            canEnumerateProjects: true,
            canReadCode: true,
            canReadPipelines: true,
            canReadDeployments: true,
          },
          details: { projectCount: 1 },
          enabled: true,
        })}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Connect GitLab' });
    fireEvent.change(within(dialog).getByLabelText('GitLab URL'), {
      target: { value: 'https://gitlab.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('Top-level group full path'), {
      target: { value: 'platform' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Read-only access token/), {
      target: { value: 'glpat-read-only' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Check access and discover projects' }),
    );
    await within(dialog).findByText('1 project discovered');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Configure event sync' }));
    fireEvent.click(within(dialog).getByLabelText(/Smee relay/));
    expect(within(dialog).getByText(/Smee can change JSON formatting/)).toBeDefined();
    fireEvent.change(within(dialog).getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/test-channel' },
    });
    expect(within(dialog).getByText(/HMAC signing token has been generated/i)).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Preparing your webhook address…')).toBeNull());
    expect(within(dialog).getByText('Set up webhooks in GitLab')).toBeDefined();
    expect(within(dialog).getByText(/Project → Settings → Webhooks/)).toBeDefined();
    expect(within(dialog).getByText(/Preview installation command/)).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText('Where are webhooks in GitLab?'));
    expect(
      within(dialog)
        .getByRole('link', { name: 'platform/checkout → Webhooks' })
        .getAttribute('href'),
    ).toBe('https://gitlab.example.com/platform/checkout/-/hooks');
    fireEvent.change(within(dialog).getByLabelText('Find project webhook settings'), {
      target: { value: 'missing' },
    });
    expect(within(dialog).queryByRole('link', { name: 'platform/checkout → Webhooks' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and verify' }));

    expect(await within(dialog).findByText('Finish GitLab event delivery')).toBeDefined();
    expect(within(dialog).getByText(/Smee rebuilds JSON/)).toBeDefined();
    expect(within(dialog).getByText(/No separate command or restart is required/i)).toBeDefined();
    expect(within(dialog).getByText(/for project_id in 42; do/)).toBeDefined();
    expect(within(dialog).getByText(/content-type: application\/json/)).toBeDefined();
    expect(within(dialog).getByText(/bash <<'SRE_PLATFORM_GITLAB_SETUP'/)).toBeDefined();
    expect(
      within(dialog).getByText(/IFS= read -r -s -p .* SRE_PLATFORM_GITLAB_SIGNING_TOKEN/),
    ).toBeDefined();
    expect(within(dialog).getByText(/set \+x/)).toBeDefined();
    expect(within(dialog).getByText(/--rawfile signing_token \/dev\/fd\/3/)).toBeDefined();
    expect(within(dialog).queryByText(/--arg signing_token/)).toBeNull();
    expect(within(dialog).getByText(/unset SRE_PLATFORM_GITLAB_SIGNING_TOKEN/)).toBeDefined();
    expect(within(dialog).queryByText(/bun run dev:gitlab-smee/)).toBeNull();
    const saved = onSave.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      settings: {
        groupId: 7,
        groupPath: 'platform',
        eventTransport: 'smee',
      },
      credential: 'glpat-read-only',
    });
    expect(saved?.webhookSigningToken).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(dialog.textContent).not.toContain(saved!.webhookSigningToken!);
    const command = within(dialog).getByLabelText('install-hook command').textContent ?? '';
    expect(command).toContain('SRE Platform 00000000');
    expect(command).toContain('select(.name == "SRE Platform 00000000")');
    expect(spawnSync('bash', ['-n'], { input: command }).status).toBe(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy one-time signing token' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(saved!.webhookSigningToken));
  });

  test.each([
    ['GitLab 18', { version: '18.11.5', enterprise: false }],
    ['an unknown GitLab version', undefined],
  ])('fails closed for new signed event setup on %s', async (_label, instance) => {
    render(
      <GitLabConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        apiBaseUrl="http://localhost:43000"
        onDiscover={async () => ({
          group: {
            id: 7,
            name: 'Platform',
            fullPath: 'platform',
            webUrl: 'https://gitlab.example.com/groups/platform',
          },
          projects: [
            {
              id: 42,
              name: 'checkout',
              pathWithNamespace: 'platform/checkout',
              webUrl: 'https://gitlab.example.com/platform/checkout',
              archived: false,
            },
          ],
          ...(instance ? { instance } : {}),
        })}
        onSave={vi.fn()}
        onRunTest={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Connect GitLab' });
    fireEvent.change(within(dialog).getByLabelText('GitLab URL'), {
      target: { value: 'https://gitlab.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('Top-level group full path'), {
      target: { value: 'platform' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Read-only access token/), {
      target: { value: 'glpat-read-only' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Check access and discover projects' }),
    );
    await within(dialog).findByText('1 project discovered');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Configure event sync' }));

    expect(within(dialog).getByText(/requires GitLab 19.1 or newer/i)).toBeDefined();
    expect((within(dialog).getByLabelText(/Smee relay/) as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText(/Public HTTPS API/) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((within(dialog).getByLabelText(/Configure later/) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  test('preserves legacy webhook authentication without offering unsupported HMAC on GitLab 18', async () => {
    render(
      <GitLabConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="edit"
        apiBaseUrl="http://localhost:43000"
        initialSettings={{
          baseUrl: 'https://gitlab.example.com',
          groupId: 7,
          groupPath: 'platform',
          eventTransport: 'smee',
          smeeConfigured: true,
          webhookSecretConfigured: true,
        }}
        credentialConfigured
        onDiscover={async () => ({
          group: {
            id: 7,
            name: 'Platform',
            fullPath: 'platform',
            webUrl: 'https://gitlab.example.com/groups/platform',
          },
          projects: [
            {
              id: 42,
              name: 'checkout',
              pathWithNamespace: 'platform/checkout',
              webUrl: 'https://gitlab.example.com/platform/checkout',
              archived: false,
            },
          ],
          instance: { version: '18.11.5', enterprise: false },
        })}
        onSave={vi.fn()}
        onRunTest={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Manage GitLab' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Check access and discover projects' }),
    );
    await within(dialog).findByText('1 project discovered');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Configure event sync' }));

    expect((within(dialog).getByLabelText(/Smee relay/) as HTMLInputElement).disabled).toBe(false);
    expect(within(dialog).getByText(/still uses GitLab's legacy secret header/i)).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /HMAC signing token/i })).toBeNull();
  });

  test('uses an idempotent Premium group hook command and preserves a self-managed port', async () => {
    render(
      <GitLabConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        apiBaseUrl="http://localhost:43000"
        onDiscover={async () => ({
          group: {
            id: 7,
            name: 'Platform',
            fullPath: 'platform',
            webUrl: 'https://gitlab.example.com:8443/groups/platform',
          },
          projects: [
            {
              id: 42,
              name: 'checkout',
              pathWithNamespace: 'platform/checkout',
              webUrl: 'https://gitlab.example.com:8443/platform/checkout',
              archived: false,
            },
          ],
          instance: { version: '19.2.4', enterprise: true },
        })}
        onSave={async () => ({
          connectorId: '00000000-0000-4000-8000-000000000001',
          name: 'GitLab',
          webhookPath: '/webhooks/gitlab/opaque-key',
          relayStatus: 'connected',
        })}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          warnings: [],
          details: { projectCount: 1 },
          enabled: true,
        })}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Connect GitLab' });
    fireEvent.change(within(dialog).getByLabelText('GitLab URL'), {
      target: { value: 'https://gitlab.example.com:8443' },
    });
    fireEvent.change(within(dialog).getByLabelText('Top-level group full path'), {
      target: { value: 'platform' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Read-only access token/), {
      target: { value: 'glpat-read-only' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Check access and discover projects' }),
    );
    await within(dialog).findByText('1 project discovered');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Configure event sync' }));
    fireEvent.click(within(dialog).getByLabelText(/Smee relay/));
    fireEvent.click(within(dialog).getByLabelText(/Group hook/));
    fireEvent.change(within(dialog).getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/test-channel' },
    });
    await waitFor(() => expect(screen.queryByText('Preparing your webhook address…')).toBeNull());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and verify' }));

    expect(await within(dialog).findByText(/groups\/7\/hooks/)).toBeDefined();
    expect(within(dialog).getByText(/method=PUT/)).toBeDefined();
    expect(within(dialog).getByText(/method=POST/)).toBeDefined();
    expect(within(dialog).getByText(/--hostname gitlab.example.com:8443/)).toBeDefined();
  });
});
