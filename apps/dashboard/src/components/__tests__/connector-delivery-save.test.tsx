// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GitLabConnectWizard } from '../GitLabConnectWizard';
import { PrometheusConnectWizard } from '../PrometheusConnectWizard';
import { installDialogMethods } from '../../test/dialog';
import {
  prepareGitLabTestDelivery,
  preparePrometheusTestDelivery,
} from '../../test/connector-delivery';

let dialogMethods: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialogMethods = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialogMethods.restore();
});

test.each([
  ['gitlab', 'direct'],
  ['gitlab', 'none'],
  ['prometheus', 'direct'],
  ['prometheus', 'none'],
] as const)(
  '%s retains its saved identity when %s verification fails and events are configured again',
  async (provider, initialTransport) => {
    const prefix = provider === 'gitlab' ? 'gitlab' : 'alertmanager';
    const savedId =
      initialTransport === 'direct'
        ? '00000000-0000-4000-8000-000000000099'
        : '00000000-0000-4000-8000-000000000079';
    const url = `https://api.example.com/webhooks/${prefix}/${savedId}`;
    const onSave = vi.fn(async (body: { id?: string; setupId?: string }) => {
      const connectorId = body.id ?? body.setupId ?? savedId;
      return { connectorId, name: provider, webhookPath: `/webhooks/${prefix}/${connectorId}` };
    });
    const onRunTest = vi
      .fn()
      .mockRejectedValueOnce(new Error('verification unavailable'))
      .mockResolvedValue({
        status: 'healthy',
        reachable: true,
        authorized: true,
        warnings: [],
        enabled: true,
        checks: {
          canReadGroup: true,
          canEnumerateProjects: true,
          canReadCode: true,
          canReadPipelines: true,
          canReadDeployments: true,
        },
        details: { projectCount: 1 },
      });
    const onPrepareDelivery = vi.fn(
      provider === 'gitlab' ? prepareGitLabTestDelivery : preparePrometheusTestDelivery,
    );
    if (provider === 'gitlab') {
      render(
        <GitLabConnectWizard
          mode="connect"
          apiBaseUrl="https://api.example.com"
          onPrepareDelivery={onPrepareDelivery}
          onSave={onSave}
          onRunTest={onRunTest}
          onClose={() => {}}
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
      await screen.findByText('1 project discovered');
      fireEvent.click(screen.getByRole('button', { name: 'Configure event sync' }));
    } else {
      render(
        <PrometheusConnectWizard
          mode="connect"
          initialSettings={{ baseUrl: '', authType: 'none', eventTransport: initialTransport }}
          apiBaseUrl="https://api.example.com"
          onPrepareDelivery={onPrepareDelivery}
          onSave={onSave}
          onRunTest={onRunTest}
          onClose={() => {}}
          loadChannels={async () => [{ id: 'CALERTS', name: 'incidents' }]}
        />,
      );
      fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
        target: { value: 'https://prometheus.example.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    }
    fireEvent.click(
      screen.getByLabelText(initialTransport === 'direct' ? /Public HTTPS API/ : /Configure later/),
    );
    if (provider === 'prometheus' && initialTransport === 'direct') {
      await screen.findByRole('option', { name: 'incidents' });
      fireEvent.change(screen.getByLabelText('Incident Slack channel'), {
        target: { value: 'CALERTS' },
      });
    }
    if (initialTransport === 'direct') await screen.findByText(url);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
    await screen.findByText(/Save or verification failed/);
    if (initialTransport === 'direct') expect(onSave.mock.calls[0]?.[0].setupId).toBe(savedId);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByLabelText(/Public HTTPS API/));
    if (provider === 'prometheus') {
      await screen.findByRole('option', { name: 'incidents' });
      fireEvent.change(screen.getByLabelText('Incident Slack channel'), {
        target: { value: 'CALERTS' },
      });
    }
    await screen.findByText(url);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
    const configuration = await screen.findByText(
      provider === 'gitlab' ? /bash <<'SRE_PLATFORM_GITLAB_SETUP'/ : /^webhook_configs:/,
    );
    expect(configuration.textContent).toContain(url);
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({ id: savedId });
    expect(onSave.mock.calls[1]?.[0].setupId).toBeUndefined();
    expect(onRunTest.mock.calls).toEqual([[savedId], [savedId]]);
  },
);
