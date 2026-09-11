// @vitest-environment jsdom
import { preparePrometheusTestDelivery as prepareTestDelivery } from '../../test/connector-delivery';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { PrometheusSettings } from '../../lib/connectors';

import { installDialogMethods } from '../../test/dialog';

import { PrometheusConnectWizard } from '../PrometheusConnectWizard';

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

describe('on-demand connector wizards', () => {
  test.each([
    {
      authType: 'none',
      fill: () => {},
      credential: { type: 'none' },
    },
    {
      authType: 'bearer',
      fill: () =>
        fireEvent.change(screen.getByLabelText('Bearer token'), {
          target: { value: 'bearer-token' },
        }),
      credential: { type: 'bearer', token: 'bearer-token' },
    },
    {
      authType: 'basic',
      fill: () => {
        fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'prom-user' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'prom-password' } });
      },
      credential: { type: 'basic', username: 'prom-user', password: 'prom-password' },
    },
    {
      authType: 'header',
      fill: () => {
        fireEvent.change(screen.getByLabelText('Header name'), {
          target: { value: 'X-Scope-OrgID' },
        });
        fireEvent.change(screen.getByLabelText('Header value'), { target: { value: 'tenant-a' } });
      },
      credential: { type: 'header', name: 'X-Scope-OrgID', value: 'tenant-a' },
    },
    {
      authType: 'mtls',
      fill: () => {
        fireEvent.change(screen.getByLabelText('Client certificate (PEM)'), {
          target: { value: '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----' },
        });
        fireEvent.change(screen.getByLabelText('Client private key (PEM)'), {
          target: { value: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----' },
        });
      },
      credential: {
        type: 'mtls',
        cert: '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----',
        key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      },
    },
  ])(
    'serializes $authType Prometheus authentication exactly',
    async ({ authType, fill, credential }) => {
      const onSave = vi.fn(async () => ({ connectorId: 'prometheus-source' }));
      render(
        <PrometheusConnectWizard
          onPrepareDelivery={prepareTestDelivery}
          mode="connect"
          onSave={onSave}
          onRunTest={async () => ({
            status: 'healthy',
            reachable: true,
            authorized: true,
            warnings: [],
            enabled: true,
          })}
          onClose={() => {}}
        />,
      );

      fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
        target: { value: 'https://prometheus.example.com' },
      });
      fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: authType } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fill();
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave).toHaveBeenCalledWith({
        name: 'Prometheus',
        settings: {
          baseUrl: 'https://prometheus.example.com',
          authType,
          caCert: '',
          insecureSkipTLSVerify: false,
          eventTransport: 'none',
          cohortWindowSec: 120,
        },
        credential: JSON.stringify(credential),
        insecureTlsAcknowledged: false,
      });
    },
  );

  test('keeps stored Prometheus secrets write-only during an edit and enables only after verification', async () => {
    const onSave = vi.fn(async () => ({
      connectorId: '00000000-0000-4000-8000-000000000001',
    }));
    const onRunTest = vi.fn(async () => ({
      status: 'healthy' as const,
      reachable: true,
      authorized: true,
      warnings: [],
      enabled: true,
    }));
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="edit"
        initialSettings={{
          baseUrl: 'https://prometheus.example.com',
          authType: 'bearer',
          caConfigured: true,
        }}
        credentialConfigured
        onSave={onSave}
        onRunTest={onRunTest}
        onClose={() => {}}
      />,
    );

    const ca = screen.getByLabelText(/CA certificate \(PEM\)/i) as HTMLTextAreaElement;
    expect(ca.value).toBe('');
    expect(screen.getByText(/PEM is never prefilled/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/leave all credential fields blank/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    expect(await screen.findByText('Prometheus metrics verified.')).toBeDefined();
    expect(onRunTest).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      name: 'Prometheus',
      settings: {
        baseUrl: 'https://prometheus.example.com',
        authType: 'bearer',
        insecureSkipTLSVerify: false,
        eventTransport: 'none',
        cohortWindowSec: 120,
      },
      insecureTlsAcknowledged: false,
    });
  });

  test('accepts an HTTP Prometheus endpoint without TLS settings', async () => {
    const onSave = vi.fn(async () => ({ connectorId: 'prometheus-http' }));
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        onSave={onSave}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          warnings: [],
          enabled: true,
        })}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
      target: { value: 'http://127.0.0.1:9090' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Acknowledge the unencrypted HTTP/i);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/HTTP does not encrypt credentials/i));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            baseUrl: 'http://127.0.0.1:9090',
            caCert: '',
            insecureSkipTLSVerify: false,
          }),
          insecureTlsAcknowledged: false,
          insecureHttpAcknowledged: true,
        }),
      ),
    );
  });

  test('guides a local Alertmanager Smee setup with an additive webhook config', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    let savedBody: {
      id?: string;
      name: string;
      settings: PrometheusSettings;
      credential?: string;
      eventToken?: string;
      insecureTlsAcknowledged?: boolean;
      insecureHttpAcknowledged?: boolean;
    } | null = null;
    const onSave = vi.fn(async (body: NonNullable<typeof savedBody>) => {
      savedBody = body;
      return {
        connectorId: 'prometheus-source',
        webhookPath: '/webhooks/alertmanager/prometheus-source',
      };
    });
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        apiBaseUrl="http://localhost:3000"
        loadChannels={async () => [{ id: 'C07ALERTS', name: '#homelab-notification' }]}
        onSave={onSave}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          warnings: [],
          enabled: true,
        })}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
      target: { value: 'https://prometheus.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('option', { name: '#homelab-notification' });
    fireEvent.change(screen.getByLabelText('Incident Slack channel'), {
      target: { value: 'C07ALERTS' },
    });
    fireEvent.change(screen.getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/alertmanager-channel' },
    });
    expect(screen.getByRole('button', { name: 'Copy Alertmanager webhook URL' })).toBeDefined();
    const tokenInput = screen.getByLabelText('Alertmanager bearer token') as HTMLInputElement;
    const initialToken = tokenInput.value;
    expect(tokenInput.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show token' }));
    expect(tokenInput.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(writeText).toHaveBeenLastCalledWith(initialToken);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate token' }));
    const rotatedToken = tokenInput.value;
    expect(rotatedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(rotatedToken).not.toBe(initialToken);
    expect(tokenInput.type).toBe('password');
    expect(screen.getByText(/Anyone with this unauthenticated channel URL/i)).toBeDefined();
    expect(screen.getByText(/Review does not save/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    expect(
      await screen.findByText('Add this webhook to your existing Alertmanager receiver'),
    ).toBeDefined();
    const webhookConfig = screen.getByText(/^webhook_configs:/);
    expect(webhookConfig.textContent).toContain('url: https://smee.io/alertmanager-channel');
    expect(webhookConfig.textContent).toContain('send_resolved: true');
    expect(webhookConfig.textContent).toContain(`credentials: ${rotatedToken}`);
    expect(webhookConfig.textContent).not.toContain('- name:');
    fireEvent.click(screen.getByRole('button', { name: 'Copy webhook config' }));
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining(`credentials: ${rotatedToken}`),
    );
    expect(savedBody).toMatchObject({
      settings: {
        eventTransport: 'smee',
        alertChannel: 'C07ALERTS',
        smeeUrl: 'https://smee.io/alertmanager-channel',
      },
    });
    expect(savedBody!.eventToken).toBe(rotatedToken);
  });

  test('requires the Smee URL again when rotating a stored Alertmanager token', async () => {
    const onSave = vi.fn(async () => ({
      connectorId: 'prometheus-source',
      webhookPath: '/webhooks/alertmanager/prometheus-source',
    }));
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="edit"
        connectorId="prometheus-source"
        apiBaseUrl="http://localhost:3000"
        initialSettings={{
          baseUrl: 'https://prometheus.example.com',
          authType: 'none',
          eventTransport: 'smee',
          alertChannel: 'C07ALERTS',
          eventCredentialConfigured: true,
          smeeConfigured: true,
        }}
        loadChannels={async () => [{ id: 'C07ALERTS', name: '#homelab-notification' }]}
        onSave={onSave}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          warnings: [],
          enabled: true,
          relayStatus: 'connected',
        })}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('option', { name: '#homelab-notification' });
    expect(screen.getByText('Leave blank to keep the stored Smee URL.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Generate new token' }));
    expect(screen.getByText(/Enter the Smee URL again/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByRole('alert').textContent).toMatch(
      /Enter the https:\/\/smee.io channel URL/i,
    );
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/alertmanager-channel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  test('keeps a stored Smee URL and token during an ordinary edit', async () => {
    const onSave = vi.fn(
      async (_body: {
        id?: string;
        name: string;
        settings: PrometheusSettings;
        credential?: string;
        eventToken?: string;
        insecureTlsAcknowledged?: boolean;
        insecureHttpAcknowledged?: boolean;
      }) => ({
        connectorId: 'prometheus-source',
        webhookPath: '/webhooks/alertmanager/prometheus-source',
      }),
    );
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="edit"
        connectorId="prometheus-source"
        apiBaseUrl="http://localhost:3000"
        initialSettings={{
          baseUrl: 'https://prometheus.example.com',
          authType: 'none',
          eventTransport: 'smee',
          alertChannel: 'C07ALERTS',
          eventCredentialConfigured: true,
          smeeConfigured: true,
        }}
        loadChannels={async () => [{ id: 'C07ALERTS', name: '#homelab-notification' }]}
        onSave={onSave}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          warnings: [],
          enabled: true,
          relayStatus: 'connected',
        })}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('option', { name: '#homelab-notification' });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const savedBody = onSave.mock.calls[0]![0];
    expect(savedBody.settings).toMatchObject({
      eventTransport: 'smee',
      alertChannel: 'C07ALERTS',
    });
    expect(savedBody.settings).not.toHaveProperty('smeeUrl');
    expect(savedBody).not.toHaveProperty('eventToken');
  });

  test('reports a failed local Alertmanager relay separately from healthy metrics', async () => {
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        apiBaseUrl="http://localhost:3000"
        loadChannels={async () => [{ id: 'C07ALERTS', name: '#homelab-notification' }]}
        onSave={async () => ({
          connectorId: 'prometheus-source',
          webhookPath: '/webhooks/alertmanager/prometheus-source',
        })}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          warnings: [],
          enabled: true,
          relayStatus: 'failed',
        })}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
      target: { value: 'https://prometheus.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('option', { name: '#homelab-notification' });
    fireEvent.change(screen.getByLabelText('Incident Slack channel'), {
      target: { value: 'C07ALERTS' },
    });
    fireEvent.change(screen.getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/alertmanager-channel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    expect(await screen.findByText(/local Smee relay could not connect/i)).toBeDefined();
    expect(screen.queryByText(/awaiting its first authenticated event/i)).toBeNull();
  });

  test('blocks public Alertmanager delivery with an HTTP-only deployment', () => {
    const onSave = vi.fn();
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        apiBaseUrl="http://localhost:43000"
        onSave={onSave}
        onRunTest={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
      target: { value: 'https://prometheus.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByLabelText(/Public HTTPS API/i));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) => alert.textContent?.includes('platform administrator')),
    ).toBe(true);
    expect(screen.queryByLabelText('SRE Platform API URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save and verify' })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  test('derives the Alertmanager webhook from the configured HTTPS API', async () => {
    const onSave = vi.fn(async () => ({
      connectorId: 'prometheus-source',
      webhookPath: '/webhooks/alertmanager/prometheus-source',
    }));
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        apiBaseUrl="https://api.example.com"
        loadChannels={async () => [{ id: 'C07ALERTS', name: '#homelab-notification' }]}
        onSave={onSave}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          warnings: [],
          enabled: true,
        })}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
      target: { value: 'https://prometheus.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByLabelText(/Public HTTPS API/i));
    await screen.findByRole('option', { name: '#homelab-notification' });
    fireEvent.change(screen.getByLabelText('Incident Slack channel'), {
      target: { value: 'C07ALERTS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    const webhookConfig = await screen.findByText(/^webhook_configs:/);
    expect(webhookConfig.textContent).toContain(
      'url: https://api.example.com/webhooks/alertmanager/prometheus-source',
    );
    expect(screen.getByText(/Alertmanager bearer token is a deployment secret/i)).toBeDefined();
    expect(screen.queryByText(/Smee URL and bearer token are development secrets/i)).toBeNull();
  });
});
