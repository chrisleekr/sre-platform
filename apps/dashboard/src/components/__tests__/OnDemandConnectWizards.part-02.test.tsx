// @vitest-environment jsdom
import { preparePrometheusTestDelivery as prepareTestDelivery } from '../../test/connector-delivery';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { installDialogMethods } from '../../test/dialog';

import { ObservabilityConnectWizard } from '../ObservabilityConnectWizard';

import { PrometheusConnectWizard } from '../PrometheusConnectWizard';

import { StatusCakeConnectWizard } from '../StatusCakeConnectWizard';

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
  test('keeps mutual TLS restricted to HTTPS after the endpoint changes', () => {
    const onSave = vi.fn();
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        onSave={onSave}
        onRunTest={vi.fn()}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
      target: { value: 'https://prometheus.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'mtls' } });
    fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
      target: { value: 'http://127.0.0.1:9090' },
    });

    const mtlsOption = screen.getByRole('option', {
      name: 'Mutual TLS (HTTPS only)',
    }) as HTMLOptionElement;
    expect(mtlsOption.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Mutual TLS requires an HTTPS/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  test('rejects forbidden custom headers and requires replacement after an auth-type change', () => {
    const onSave = vi.fn();
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="edit"
        initialSettings={{ baseUrl: 'https://prometheus.example.com', authType: 'bearer' }}
        credentialConfigured
        onSave={onSave}
        onRunTest={vi.fn()}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'header' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Header name'), { target: { value: 'Authorization' } });
    fireEvent.change(screen.getByLabelText('Header value'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/safe custom authentication header/i);

    fireEvent.change(screen.getByLabelText('Header name'), { target: { value: 'X-Scope-OrgID' } });
    fireEvent.change(screen.getByLabelText('Header value'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/header credential required/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  test('requires explicit acknowledgement before disabling Prometheus TLS verification', () => {
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        onSave={vi.fn()}
        onRunTest={vi.fn()}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Prometheus base URL'), {
      target: { value: 'https://prometheus.example.com' },
    });
    fireEvent.click(screen.getByLabelText('Disable certificate verification'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/acknowledge the insecure TLS risk/i);

    fireEvent.click(
      screen.getByLabelText(
        /I understand that disabling TLS verification permits server impersonation/,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter the read credential')).toBeDefined();
  });

  test('explains independent provider episodes without obsolete grouping controls', async () => {
    const onSave = vi.fn(async () => ({
      connectorId: '00000000-0000-4000-8000-000000000099',
      webhookPath: '/webhooks/alertmanager/test',
    }));
    render(
      <PrometheusConnectWizard
        onPrepareDelivery={prepareTestDelivery}
        mode="connect"
        apiBaseUrl="https://sre.example"
        loadChannels={async () => [{ id: 'C07ALERTS', name: '#alerts' }]}
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
    fireEvent.change(await screen.findByLabelText('Incident Slack channel'), {
      target: { value: 'C07ALERTS' },
    });
    expect(screen.getByText('Independent provider episodes')).toBeDefined();
    expect(screen.queryByLabelText('Episode grouping window in minutes')).toBeNull();
    expect(screen.queryByLabelText('Maximum incident correlation age in hours')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('Independent incident per provider episode')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({}),
      }),
    );
  });

  test('guides a StatusCake token through disabled save and explicit verification', async () => {
    const onSave = vi.fn(async () => ({
      connectorId: '00000000-0000-4000-8000-000000000002',
    }));
    const onRunTest = vi.fn(async () => ({
      status: 'healthy' as const,
      reachable: true,
      authorized: true,
      warnings: [],
      enabled: true,
    }));
    render(
      <StatusCakeConnectWizard
        mode="connect"
        onSave={onSave}
        onRunTest={onRunTest}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'status-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ name: 'StatusCake', credential: 'status-token' }),
    );
    expect(await screen.findByText('StatusCake connector enabled.')).toBeDefined();
    expect(onRunTest).toHaveBeenCalledTimes(1);
  });

  test('guides a named Datadog source through both required write-only keys', async () => {
    const onSave = vi.fn(async () => ({
      connectorId: '00000000-0000-4000-8000-000000000003',
    }));
    const onRunTest = vi.fn(async () => ({
      status: 'healthy' as const,
      reachable: true,
      authorized: true,
      warnings: [],
      enabled: true,
    }));
    render(
      <ObservabilityConnectWizard
        type="datadog"
        mode="connect"
        onSave={onSave}
        onRunTest={onRunTest}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Data source name/), {
      target: { value: 'EU Datadog' },
    });
    fireEvent.change(screen.getByLabelText('Datadog site'), {
      target: { value: 'datadoghq.eu' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'api-key' } });
    fireEvent.change(screen.getByLabelText('Application key'), { target: { value: 'app-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: 'EU Datadog',
        settings: { site: 'datadoghq.eu' },
        credential: JSON.stringify({ apiKey: 'api-key', appKey: 'app-key' }),
      }),
    );
    expect(await screen.findByText('EU Datadog enabled.')).toBeDefined();
    expect(onRunTest).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000003');
  });

  test('edits Grafana without prefilling its stored token or CA', async () => {
    const onSave = vi.fn(async () => ({
      connectorId: '00000000-0000-4000-8000-000000000004',
    }));
    const onRunTest = vi.fn(async () => ({
      status: 'healthy' as const,
      reachable: true,
      authorized: true,
      warnings: [],
      enabled: true,
    }));
    render(
      <ObservabilityConnectWizard
        type="grafana"
        mode="edit"
        connectorId="00000000-0000-4000-8000-000000000004"
        initialName="Operations Grafana"
        initialSettings={{
          baseUrl: 'https://grafana.example.com',
          caConfigured: true,
        }}
        credentialConfigured
        onSave={onSave}
        onRunTest={onRunTest}
        onClose={() => {}}
      />,
    );

    const ca = screen.getByLabelText('CA certificate (PEM)') as HTMLTextAreaElement;
    expect(ca.value).toBe('');
    expect(ca.placeholder).toMatch(/keep the stored CA/i);
    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));
    expect((screen.getByLabelText('Service account token') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/Leave credential fields blank/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        id: '00000000-0000-4000-8000-000000000004',
        name: 'Operations Grafana',
        settings: {
          baseUrl: 'https://grafana.example.com',
          insecureSkipTLSVerify: false,
        },
      }),
    );
    expect(await screen.findByText('Operations Grafana enabled.')).toBeDefined();
  });

  test('accepts an HTTP Grafana endpoint without TLS settings', async () => {
    const onSave = vi.fn(async () => ({ connectorId: 'grafana-http' }));
    render(
      <ObservabilityConnectWizard
        type="grafana"
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

    fireEvent.change(screen.getByLabelText('Grafana base URL'), {
      target: { value: 'http://127.0.0.1:3000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Acknowledge the unencrypted HTTP/i);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/HTTP does not encrypt credentials/i));
    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));
    fireEvent.change(screen.getByLabelText('Service account token'), {
      target: { value: 'grafana-service-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: 'Grafana',
        settings: {
          baseUrl: 'http://127.0.0.1:3000',
          caCert: '',
          insecureSkipTLSVerify: false,
        },
        credential: 'grafana-service-token',
        insecureHttpAcknowledged: true,
      }),
    );
  });
});
