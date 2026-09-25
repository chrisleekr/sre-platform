// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ObservabilityConnectWizard } from '../ObservabilityConnectWizard';
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'https://sre.example' } }));
import { installDialogMethods } from '../../test/dialog';
let dialogs: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialogs = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialogs.restore();
});
const id = '00000000-0000-4000-8000-000000000073';
const onRunTest = async () => ({
  status: 'healthy' as const,
  reachable: true,
  authorized: true,
  warnings: [],
  enabled: true,
});
test.each(['datadog', 'grafana'] as const)(
  '%s first native setup immediately exposes the complete endpoint and authentication steps',
  async (type) => {
    // A webhook key differs from the connector id, so the URL must come from the server.
    const onSave = async () => ({ connectorId: id, webhookPath: `/webhooks/${type}/webhook-key` });
    render(
      <ObservabilityConnectWizard
        type={type}
        mode="connect"
        onSave={onSave}
        onRunTest={onRunTest}
        onClose={() => {}}
      />,
    );
    if (type === 'grafana')
      fireEvent.change(screen.getByLabelText('Grafana base URL'), {
        target: { value: 'https://grafana.example' },
      });
    fireEvent.click(screen.getByLabelText('Receive authenticated alert lifecycle events'));
    fireEvent.change(screen.getByLabelText('Subscribed Slack alert channel ID'), {
      target: { value: 'C07ALERTS' },
    });
    fireEvent.change(screen.getByLabelText('Webhook bearer token'), {
      target: { value: 'independent-event-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));
    if (type === 'datadog') {
      fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'api-key' } });
      fireEvent.change(screen.getByLabelText('Application key'), { target: { value: 'app-key' } });
    } else
      fireEvent.change(screen.getByLabelText('Service account token'), {
        target: { value: 'read-token' },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
    expect(
      await screen.findByText(`https://sre.example/webhooks/${type}/webhook-key`),
    ).toBeDefined();
    expect(screen.queryByText(new RegExp(id))).toBeNull();
    expect(screen.getByText(/Authorization: Bearer/)).toBeDefined();
    expect(screen.queryByText('independent-event-token')).toBeNull();
  },
);
