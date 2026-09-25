// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import type { ConnectorSummary } from '../../lib/connectors';
import { ConnectorLifecyclePanel } from '../ConnectorLifecyclePanel';
vi.mock('../../lib/useIncidents', () => ({
  useIncidents: () => ({
    incidents: [{ id: 'incident-internal', title: 'Checkout timeout', severity: 'sev2' }],
  }),
}));
vi.mock('../../lib/authenticatedFetch', () => ({ authenticatedFetch: vi.fn() }));
const getCredentials = async () => ({ kind: 'cookie' as const });
const connector: ConnectorSummary = {
  id: 'connector-internal',
  type: 'statuscake',
  name: 'Uptime',
  settings: {},
  enabled: true,
  capabilities: {
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'none',
    events: 'authenticated',
    alertLifecycle: 'read',
  },
};
test('selects readable incidents and signals, previews evidence, and binds with fresh versions and a reason', async () => {
  vi.mocked(authenticatedFetch)
    .mockReset()
    .mockResolvedValueOnce(
      Response.json({
        signals: [
          {
            id: 'signal-internal',
            summary: 'Checkout timed out',
            provider: 'statuscake',
            state: 'firing',
          },
        ],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        verified: true,
        startsAt: '2026-09-21T00:00:00Z',
        status: 'resolved',
        signalVersion: 4,
        lifecycleVersion: 2,
        connectorVersion: 7,
      }),
    )
    .mockResolvedValueOnce(Response.json({ bound: true, nextStep: 'Reconcile this connector.' }));
  render(
    <ConnectorLifecyclePanel connector={connector} getCredentials={getCredentials} canConfigure />,
  );
  expect(screen.queryByText('signal-internal')).toBeNull();
  fireEvent.change(screen.getByLabelText('Open incident'), {
    target: { value: 'incident-internal' },
  });
  await screen.findByText('statuscake: Checkout timed out (firing)');
  fireEvent.change(screen.getByLabelText('Provider signal'), {
    target: { value: 'signal-internal' },
  });
  fireEvent.change(screen.getByLabelText('Provider monitor ID'), { target: { value: '73' } });
  fireEvent.click(screen.getByText('Preview provider evidence'));
  await screen.findByText(/Verified episode:/);
  expect((screen.getByText('Bind this episode') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Binding reason'), {
    target: { value: 'Checked the exact provider test' },
  });
  fireEvent.click(screen.getByText('Bind this episode'));
  await screen.findByText('Reconcile this connector.');
  const body = JSON.parse(String(vi.mocked(authenticatedFetch).mock.calls[2]?.[2]?.body));
  expect(body).toMatchObject({
    mode: 'bind',
    signalId: 'signal-internal',
    monitorId: '73',
    family: 'uptime',
    signalVersion: 4,
    lifecycleVersion: 2,
    connectorVersion: 7,
    reason: 'Checked the exact provider test',
  });
});
test('a failed signal load offers a retry that reloads the same incident', async () => {
  vi.mocked(authenticatedFetch)
    .mockReset()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({
        signals: [
          {
            id: 'signal-internal',
            summary: 'Checkout timed out',
            provider: 'statuscake',
            state: 'firing',
          },
        ],
      }),
    );
  render(
    <ConnectorLifecyclePanel connector={connector} getCredentials={getCredentials} canConfigure />,
  );
  fireEvent.change(screen.getByLabelText('Open incident'), {
    target: { value: 'incident-internal' },
  });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Unable to load incident signals.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('statuscake: Checkout timed out (firing)');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(authenticatedFetch).toHaveBeenCalledTimes(2);
});

test('changing a provider monitor discards the earlier preview', async () => {
  vi.mocked(authenticatedFetch)
    .mockReset()
    .mockResolvedValueOnce(
      Response.json({
        signals: [{ id: 'signal-internal', summary: 'Checkout timed out', state: 'unknown' }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ verified: true, startsAt: '2026-09-21T00:00:00Z', status: 'firing' }),
    );
  render(
    <ConnectorLifecyclePanel connector={connector} getCredentials={getCredentials} canConfigure />,
  );
  fireEvent.change(screen.getByLabelText('Open incident'), {
    target: { value: 'incident-internal' },
  });
  await screen.findByText('Notification: Checkout timed out (unknown)');
  fireEvent.change(screen.getByLabelText('Provider signal'), {
    target: { value: 'signal-internal' },
  });
  fireEvent.change(screen.getByLabelText('Provider monitor ID'), { target: { value: '73' } });
  fireEvent.click(screen.getByText('Preview provider evidence'));
  await screen.findByText(/Verified episode:/);
  fireEvent.change(screen.getByLabelText('Provider monitor ID'), { target: { value: '74' } });
  await waitFor(() => expect(screen.queryByText('Bind this episode')).toBeNull());
});
test('evidence-only connectors disclose missing lifecycle coverage and expose no binding action', () => {
  render(
    <ConnectorLifecyclePanel
      connector={{
        ...connector,
        type: 'newrelic',
        capabilities: { ...connector.capabilities!, alertLifecycle: 'none' },
      }}
      getCredentials={getCredentials}
      canConfigure
    />,
  );
  expect(screen.getByText(/Evidence access only/)).toBeDefined();
  expect(screen.queryByText('Preview provider evidence')).toBeNull();
});
test('Datadog cycle association is explicit, keeps read-only reconciliation available and links an existing canonical incident', async () => {
  vi.mocked(authenticatedFetch)
    .mockReset()
    .mockResolvedValueOnce(
      Response.json({ signals: [{ id: 'legacy-signal', summary: 'Checkout', state: 'unknown' }] }),
    )
    .mockResolvedValueOnce(
      Response.json({
        verified: true,
        startsAt: '2026-09-21T00:00:00Z',
        status: 'firing',
        nativeAssociation: 'cycle_key_required',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        verified: true,
        startsAt: '2026-09-21T00:00:00Z',
        status: 'firing',
        nativeAssociation: 'awaiting_authenticated_event',
      }),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          error: 'This native cycle already has a canonical incident.',
          canonicalIncidentId: 'canonical-incident',
          nextStep: 'Use audited administrative supersession for the duplicate.',
        },
        { status: 409 },
      ),
    );
  render(
    <ConnectorLifecyclePanel
      connector={{ ...connector, type: 'datadog' }}
      getCredentials={getCredentials}
      canConfigure
    />,
  );
  fireEvent.change(screen.getByLabelText('Open incident'), {
    target: { value: 'incident-internal' },
  });
  await screen.findByText('Notification: Checkout (unknown)');
  fireEvent.change(screen.getByLabelText('Provider signal'), {
    target: { value: 'legacy-signal' },
  });
  fireEvent.change(screen.getByLabelText('Provider monitor ID'), { target: { value: '127' } });
  fireEvent.click(screen.getByText('Preview provider evidence'));
  await screen.findByText(
    'API evidence verified. Native association requires an explicit cycle key.',
  );
  expect(screen.getByText('Reconcile bound episodes')).toBeDefined();
  fireEvent.change(screen.getByLabelText('Native alert cycle key (optional)'), {
    target: { value: 'opaque-cycle' },
  });
  expect(screen.queryByText('Bind this episode')).toBeNull();
  fireEvent.click(screen.getByText('Preview provider evidence'));
  await screen.findByText(
    'Native association pending an authenticated delivery matching this exact cycle and start.',
  );
  fireEvent.change(screen.getByLabelText('Binding reason'), {
    target: { value: 'Reviewed provider payload' },
  });
  fireEvent.click(screen.getByText('Bind this episode'));
  await screen.findByText(/audited administrative supersession/);
  expect(screen.getByRole('link', { name: 'Review canonical incident' }).getAttribute('href')).toBe(
    '/w/incidents/canonical-incident',
  );
  expect(JSON.parse(String(vi.mocked(authenticatedFetch).mock.calls[3]?.[2]?.body))).toMatchObject({
    cycleKey: 'opaque-cycle',
  });
});
