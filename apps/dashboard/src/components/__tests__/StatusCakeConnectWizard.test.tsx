// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installDialogMethods } from '../../test/dialog';

const apiBase = vi.hoisted(() => ({ value: 'https://sre.example' }));
vi.mock('../../config', () => ({
  config: {
    get apiBaseUrl() {
      return apiBase.value;
    },
  },
}));
import { StatusCakeConnectWizard } from '../StatusCakeConnectWizard';

let dialog: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  apiBase.value = 'https://sre.example';
  dialog = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialog.restore();
});

const id = '00000000-0000-4000-8000-000000000073';
const healthy = {
  status: 'healthy' as const,
  reachable: true,
  authorized: true,
  warnings: [],
  enabled: true,
};
const tests = [
  { id: '73', name: 'Checkout', url: 'https://shop.example', status: 'up', paused: false },
  { id: '74', name: 'Status page', url: 'https://status.example', status: 'down', paused: false },
];

function renderWizard(overrides: Partial<Parameters<typeof StatusCakeConnectWizard>[0]> = {}) {
  const props = {
    mode: 'connect' as const,
    onSave: vi.fn(async (_body: unknown) => ({ connectorId: id })),
    onRunTest: vi.fn(async () => healthy),
    loadChannels: vi.fn(async () => [{ id: 'C07ALERTS', name: 'alerts' }]),
    onListTests: vi.fn(async () => ({ tests })),
    onSetup: vi.fn(async () => ({
      tests: [
        { ...tests[0]!, state: 'created' as const },
        { ...tests[1]!, state: 'not_bound' as const },
      ],
      changes: 2,
    })),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<StatusCakeConnectWizard {...props} />);
  return props;
}

async function reachNotifications() {
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'bearer-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
  await screen.findByRole('checkbox', { name: /Checkout/ });
}

test('all-tests mode saves exclusions and lets the platform create the contact groups', async () => {
  const props = renderWizard();
  await reachNotifications();
  expect(props.onSave).toHaveBeenNthCalledWith(1, {
    name: 'StatusCake',
    credential: 'bearer-token',
  });
  expect((screen.getByLabelText(/All uptime tests/) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/2 of 2 tests will open incidents/)).toBeDefined();

  fireEvent.click(screen.getByRole('checkbox', { name: /Status page/ }));
  expect(screen.getByText(/1 of 2 tests will open incidents/)).toBeDefined();
  fireEvent.change(screen.getByLabelText('Incident Slack channel'), {
    target: { value: 'C07ALERTS' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save and set up' }));

  expect(
    await screen.findByText('StatusCake alerts from 1 test now open incidents.'),
  ).toBeDefined();
  expect(props.onSave).toHaveBeenLastCalledWith({
    id,
    name: 'StatusCake',
    settings: {
      eventTransport: 'direct',
      setupMode: 'auto',
      uptimeMonitorIds: [],
      excludedMonitorIds: ['74'],
      alertChannel: 'C07ALERTS',
      receiverOrigin: 'https://sre.example',
    },
  });
  expect(props.onSetup).toHaveBeenCalledWith(id);
  expect(screen.getByText('Contact group created')).toBeDefined();
  // The legacy webhook Token is gone from the flow entirely.
  expect(screen.queryByText(/webhook Token/i)).toBeNull();
});

test('chosen-tests mode requires a selection and saves only the chosen tests', async () => {
  const props = renderWizard();
  await reachNotifications();
  fireEvent.click(screen.getByLabelText(/Only tests I choose/));
  fireEvent.change(screen.getByLabelText('Incident Slack channel'), {
    target: { value: 'C07ALERTS' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save and set up' }));
  expect(screen.getByRole('alert').textContent).toContain('Choose at least one uptime test');

  fireEvent.click(screen.getByRole('checkbox', { name: /Checkout/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save and set up' }));
  await waitFor(() =>
    expect(props.onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ setupMode: 'custom', uptimeMonitorIds: ['73'] }),
      }),
    ),
  );
});

test('search narrows the list and select all applies only to matching tests', async () => {
  renderWizard();
  await reachNotifications();
  fireEvent.click(screen.getByLabelText(/Only tests I choose/));
  fireEvent.change(screen.getByLabelText('Search uptime tests'), { target: { value: 'status' } });
  expect(screen.queryByRole('checkbox', { name: /Checkout/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
  expect(screen.getByText(/1 of 2 tests will open incidents/)).toBeDefined();
});

test('without a public HTTPS API only Off is available and the reason is shown', async () => {
  apiBase.value = 'http://localhost:43000';
  renderWizard();
  await screen.findByLabelText('API token');
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'bearer-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
  expect(await screen.findByText(/need a public HTTPS\s+API address/)).toBeDefined();
  expect((screen.getByLabelText(/All uptime tests/) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText(/^Off/) as HTMLInputElement).checked).toBe(true);
});

test('a rejected token keeps the saved draft for the retry', async () => {
  const onRunTest = vi
    .fn()
    .mockResolvedValueOnce({ ...healthy, status: 'unhealthy', authorized: false })
    .mockResolvedValue(healthy);
  const onSave = vi.fn(async (_body: unknown) => ({ connectorId: id }));
  renderWizard({ onRunTest, onSave });
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
  expect((await screen.findByRole('alert')).textContent).toContain('rejected this API token');
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'right' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
  await screen.findByRole('checkbox', { name: /Checkout/ });
  expect(onSave.mock.calls[1]![0]).toMatchObject({ id, credential: 'right' });
});

test('a setup failure is shown with a retry', async () => {
  const onSetup = vi
    .fn()
    .mockResolvedValueOnce({
      tests: [],
      error: { category: 'rate_limited', message: 'StatusCake rate limit reached.' },
    })
    .mockResolvedValue({ tests: [{ ...tests[0]!, state: 'ready' }], changes: 0 });
  renderWizard({ onSetup });
  await reachNotifications();
  fireEvent.change(screen.getByLabelText('Incident Slack channel'), {
    target: { value: 'C07ALERTS' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save and set up' }));
  expect((await screen.findByRole('alert')).textContent).toContain('rate limit reached');
  fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
  expect(
    await screen.findByText('StatusCake alerts from 1 test now open incidents.'),
  ).toBeDefined();
});

test('a Slack problem does not hide the uptime tests', async () => {
  renderWizard({
    loadChannels: vi.fn(async () => Promise.reject(new Error('no bot token stored'))),
  });
  await reachNotifications();
  expect(screen.getByText(/Connect Slack under Connections/)).toBeDefined();
  expect(screen.queryByText('no bot token stored')).toBeNull();
});

test('a failed test listing keeps Save disabled so saved exclusions are never dropped', async () => {
  const props = renderWizard({
    mode: 'edit',
    connectorId: id,
    initialName: 'StatusCake',
    credentialConfigured: true,
    initialSettings: {
      eventTransport: 'direct',
      setupMode: 'auto',
      excludedMonitorIds: ['74'],
      alertChannel: 'C07ALERTS',
    },
    onListTests: vi.fn(async () => ({
      tests: [],
      error: { category: 'rate_limited', message: 'StatusCake rate limit reached.' },
    })),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('StatusCake rate limit reached.')).toBeDefined();
  expect(
    (screen.getByRole('button', { name: 'Save and set up' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(props.onSave).not.toHaveBeenCalled();
});

test('a failed reload after Back discards the earlier list and keeps Save disabled', async () => {
  const onListTests = vi
    .fn()
    .mockResolvedValueOnce({ tests })
    .mockResolvedValueOnce({
      tests: [],
      error: { category: 'rate_limited', message: 'StatusCake rate limit reached.' },
    });
  const props = renderWizard({
    mode: 'edit',
    connectorId: id,
    initialName: 'StatusCake',
    credentialConfigured: true,
    initialSettings: { eventTransport: 'direct', setupMode: 'auto', alertChannel: 'C07ALERTS' },
    onListTests,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('checkbox', { name: /Checkout/ });
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('StatusCake rate limit reached.')).toBeDefined();
  expect(screen.queryByRole('checkbox', { name: /Checkout/ })).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Save and set up' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(props.onSave).not.toHaveBeenCalled();
});

test('turning alerts off always runs setup so the platform groups are removed', async () => {
  const props = renderWizard({
    mode: 'edit',
    connectorId: id,
    initialName: 'StatusCake',
    credentialConfigured: true,
    initialSettings: { eventTransport: 'none' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText(/^Off/);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('StatusCake alerts no longer open incidents.')).toBeDefined();
  expect(props.onSetup).toHaveBeenCalledWith(id);
});
