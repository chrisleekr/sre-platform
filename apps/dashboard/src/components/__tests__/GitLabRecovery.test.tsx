// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { installDialogMethods } from '../../test/dialog';
import { prepareGitLabTestDelivery } from '../../test/connector-delivery';
import { GitLabConnectWizard, type GitLabConnectWizardProps } from '../GitLabConnectWizard';
import { GitLabDiscoveryRequestError } from '../../lib/connector-api/gitlab';
import type { GitLabDiscovery } from '../../lib/connectors';

let dialog: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialog = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialog.restore();
});
const discovery: GitLabDiscovery = {
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
  instance: { version: '19.2.4', enterprise: true },
};

test('keeps entered values on failure, displays the diagnostic, and allows retry', async () => {
  const onDiscover = vi
    .fn()
    .mockRejectedValueOnce(
      new GitLabDiscoveryRequestError(
        'GitLab is temporarily unavailable. Diagnostic reference: test-reference.',
      ),
    )
    .mockResolvedValue(discovery);
  render(
    <GitLabConnectWizard
      mode="connect"
      apiBaseUrl="http://localhost:43000"
      onDiscover={onDiscover}
      onPrepareDelivery={prepareGitLabTestDelivery}
      onSave={vi.fn()}
      onRunTest={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('GitLab URL'), {
    target: { value: 'https://gitlab.example.com' },
  });
  fireEvent.change(screen.getByLabelText('Top-level group full path'), {
    target: { value: 'platform' },
  });
  fireEvent.change(screen.getByLabelText(/Read-only access token/), {
    target: { value: 'test-token' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Check access and discover projects' }));
  expect((await screen.findByRole('alert')).textContent).toContain('test-reference');
  expect((screen.getByLabelText(/Read-only access token/) as HTMLInputElement).value).toBe(
    'test-token',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check access and discover projects' }));
  await screen.findByText('1 project discovered');
  expect(onDiscover).toHaveBeenCalledTimes(2);
});

test('retains saved group hook scope and regenerates commands without retrieving the signing token', async () => {
  const onSave = vi.fn(async (_body: Parameters<GitLabConnectWizardProps['onSave']>[0]) => ({
    connectorId: '00000000-0000-4000-8000-000000000007',
    name: 'GitLab',
    webhookPath: '/webhooks/gitlab/saved',
  }));
  render(
    <GitLabConnectWizard
      mode="edit"
      connectorId="00000000-0000-4000-8000-000000000007"
      apiBaseUrl="https://api.example.com"
      initialWebhookPath="/webhooks/gitlab/saved"
      credentialConfigured
      initialSettings={{
        baseUrl: 'https://gitlab.example.com',
        groupPath: 'platform',
        eventTransport: 'direct',
        hookScope: 'group',
        webhookSigningTokenConfigured: true,
      }}
      onDiscover={async () => discovery}
      onPrepareDelivery={prepareGitLabTestDelivery}
      onSave={onSave}
      onRunTest={async () => ({
        status: 'healthy',
        reachable: true,
        authorized: true,
        enabled: true,
        warnings: [],
      })}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check access and discover projects' }));
  await screen.findByText('1 project discovered');
  fireEvent.click(screen.getByRole('button', { name: 'Configure event sync' }));
  expect((screen.getByLabelText(/Group hook/) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/The saved signing token cannot be retrieved/)).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Copy one-time signing token' })).toBeNull();
  expect(screen.getByLabelText('install-hook command').textContent).toContain('groups/7/hooks');
  expect(
    screen.getByRole('link', { name: 'Open group webhook settings' }).getAttribute('href'),
  ).toBe('https://gitlab.example.com/groups/platform/-/hooks');
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
  await screen.findByText('Finish GitLab event delivery');
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({ settings: { hookScope: 'group' } });
  expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('webhookSigningToken');
  expect(screen.getByText(/Delivery is not verified by this access check/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Edit configuration' }));
  expect(screen.getByLabelText('GitLab URL')).toBeDefined();
});

test.each(
  (['system', 'group', 'managed_projects'] as const).flatMap((eventStrategy) =>
    (['direct', 'smee', 'none'] as const).map((eventTransport) => ({
      eventStrategy,
      eventTransport,
    })),
  ),
)(
  'restores and saves $eventStrategy independently of $eventTransport, ignoring stale legacy scope',
  async ({ eventStrategy, eventTransport }) => {
    const scopeLabel =
      eventStrategy === 'system'
        ? /System hook \+ polling/
        : eventStrategy === 'group'
          ? /Group hook/
          : /Project hooks Every/;
    const onSave = vi.fn(async (_body: Parameters<GitLabConnectWizardProps['onSave']>[0]) => ({
      connectorId: '00000000-0000-4000-8000-000000000007',
      name: 'GitLab',
      webhookPath: '/webhooks/gitlab/saved',
    }));
    render(
      <GitLabConnectWizard
        mode="edit"
        connectorId="00000000-0000-4000-8000-000000000007"
        apiBaseUrl="https://api.example.com"
        initialWebhookPath="/webhooks/gitlab/saved"
        credentialConfigured
        initialSettings={{
          baseUrl: 'https://gitlab.example.com',
          groupPath: 'platform',
          eventTransport,
          eventStrategy,
          hookScope: eventStrategy === 'group' ? 'projects' : 'group',
          webhookSigningTokenConfigured: true,
          smeeConfigured: eventTransport === 'smee',
        }}
        onDiscover={async () => ({
          ...discovery,
          instance: { version: '19.2.4', enterprise: false },
        })}
        onPrepareDelivery={prepareGitLabTestDelivery}
        onSave={onSave}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          enabled: true,
          warnings: [],
        })}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check access and discover projects' }));
    await screen.findByText('1 project discovered');
    fireEvent.click(screen.getByRole('button', { name: 'Configure event sync' }));
    expect((screen.getByRole('radio', { name: scopeLabel }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.getByRole('radio', { name: /Group hook/ })).toBeDefined();
    if (eventTransport === 'smee')
      fireEvent.change(screen.getByLabelText('Smee channel URL'), {
        target: { value: 'https://smee.io/fixture-channel' },
      });
    if (eventTransport !== 'none' && eventStrategy === 'system') {
      const command = screen.getByLabelText('install-hook command').textContent;
      expect(command).toContain("'hooks'");
      expect(command).toContain('repository_update_events');
      expect(command).not.toContain('pipeline_events');
      expect(command).not.toContain('for project_id');
      expect(screen.getByText(/instance administrator access/)).toBeDefined();
      expect(screen.getByText(/generic mock system-hook test may be ignored/)).toBeDefined();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
    await screen.findByRole('button', { name: 'Finish' });
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      settings: { eventStrategy, eventTransport },
    });
    if (eventStrategy === 'system')
      expect(onSave.mock.calls[0]?.[0].settings).not.toHaveProperty('hookScope');
    else
      expect(onSave.mock.calls[0]?.[0].settings.hookScope).toBe(
        eventStrategy === 'group' ? 'group' : 'projects',
      );
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('credential');
    fireEvent.click(screen.getByRole('button', { name: 'Edit configuration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check access and discover projects' }));
    await screen.findByText('1 project discovered');
    fireEvent.click(screen.getByRole('button', { name: 'Configure event sync' }));
    expect((screen.getByRole('radio', { name: scopeLabel }) as HTMLInputElement).checked).toBe(
      true,
    );
  },
);
