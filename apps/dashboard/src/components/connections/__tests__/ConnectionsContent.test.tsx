// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { SurfaceSummary } from '../../../lib/surfaces';
import { ConnectionsContent } from '../ConnectionsContent';

const chat = vi.hoisted(() => ({
  surfaces: [] as SurfaceSummary[],
  loading: false,
  error: false,
  refetch: vi.fn(),
}));
vi.mock('../../../lib/useSurfaces', () => ({ useSurfaces: () => chat }));
vi.mock('../../InboundPanel', () => ({ InboundPanel: () => <p>Chat access and subscriptions</p> }));
const props: ComponentProps<typeof ConnectionsContent> = {
  canConfigure: true,
  connectors: [],
  loading: false,
  error: false,
  refetch: vi.fn(),
  onAdd: vi.fn(),
  activeInvestigations: new Map(),
  getCredentials: async () => ({ kind: 'bearer', token: 'test' }),
  busyAction: null,
  confirmDisconnect: null,
  onManage: vi.fn(),
  onRetest: vi.fn(),
  onRequestDisconnect: vi.fn(),
  onCancelDisconnect: vi.fn(),
  onDisconnect: vi.fn(),
};
function Location() {
  return <output aria-label="Location">{useLocation().search}</output>;
}
function mount(overrides: Partial<typeof props> = {}, route = '/w/connectors') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ConnectionsContent {...props} {...overrides} />
      <Location />
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  chat.surfaces = [];
  chat.error = false;
  chat.loading = false;
  vi.clearAllMocks();
});

test('empty inventory has one add action and no wall of unconfigured providers', () => {
  mount();
  expect(screen.getByText('Connect your first tool')).toBeDefined();
  expect(screen.queryByText('Not configured')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
  expect(screen.getByLabelText('Location').textContent).toBe('?view=catalog');
  fireEvent.change(screen.getByLabelText('Search providers'), { target: { value: 'metrics' } });
  expect(screen.getByRole('button', { name: 'Add Prometheus & Alertmanager' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Add GitLab' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to connections' }));
  expect(screen.getByText('Connect your first tool')).toBeDefined();
});
test('inventory filters instances and opens a directly addressable detail', () => {
  mount({
    connectors: [
      { id: 'prod', name: 'Production', type: 'kubernetes', settings: {}, enabled: true },
      { id: 'dev', name: 'Development', type: 'kubernetes', settings: {}, enabled: false },
    ],
  });
  fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: 'prod' } });
  expect(screen.queryByRole('article', { name: 'Development' })).toBeNull();
  fireEvent.click(
    within(screen.getByRole('article', { name: 'Production' })).getByRole('button', {
      name: 'Review setup',
    }),
  );
  expect(screen.getByLabelText('Location').textContent).toBe('?connection=prod');
  expect(screen.getByRole('button', { name: 'Manage' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Disconnect' }).closest('details')?.open).toBe(false);
  fireEvent.click(screen.getByText('More actions'));
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Back to connections' }));
  expect(screen.getByLabelText('Search connections')).toHaveProperty('value', 'prod');
});
test('direct links do not silently fall back to the inventory for a missing connection', () => {
  mount({}, '/w/connectors?connection=missing');
  expect(screen.getByText('Connection not found.')).toBeDefined();
  expect(screen.queryByText('Connect your first tool')).toBeNull();
});
test.each([false, true])('leaves detail only after confirmed disconnect: %s', async (removed) => {
  const onDisconnect = vi.fn(async () => removed);
  mount(
    {
      connectors: [
        { id: 'prod', name: 'Production', type: 'kubernetes', settings: {}, enabled: true },
      ],
      confirmDisconnect: 'prod',
      onDisconnect,
    },
    '/w/connectors?connection=prod',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
  await waitFor(() => {
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Location').textContent).toBe(removed ? '' : '?connection=prod');
  });
  expect(screen.queryByRole('heading', { name: 'Connection details' }) !== null).toBe(!removed);
});
test('needs attention includes saved connections whose verification has not completed', () => {
  mount({
    connectors: ['datadog', 'grafana'].map((type) => ({
      id: type,
      name: type,
      type,
      settings: {},
      enabled: false,
      credentialConfigured: true,
      verification: { lastAttemptAt: null, lastSuccessAt: null, failureCategory: null },
    })),
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /Needs attention/ }));
  expect(screen.getByRole('article', { name: 'datadog' })).toBeDefined();
  expect(screen.getByRole('article', { name: 'grafana' })).toBeDefined();
  expect(screen.getAllByText('Not verified')).toHaveLength(2);
});
test('a failed load is not an empty workspace and does not hide other connection kinds', () => {
  chat.error = true;
  mount({
    connectors: [
      { id: 'prod', name: 'Production', type: 'kubernetes', settings: {}, enabled: false },
    ],
  });
  expect(screen.getByRole('alert').textContent).toContain('Could not load chat');
  expect(screen.getByRole('article', { name: 'Production' })).toBeDefined();
  expect(screen.queryByText('Connect your first tool')).toBeNull();
});
test('Slack discovery opens the existing chat configuration instead of a second credential model', () => {
  mount({}, '/w/connectors?view=catalog');
  fireEvent.click(screen.getByRole('button', { name: 'Add Slack' }));
  expect(screen.getByLabelText('Location').textContent).toBe('?connection=slack');
  expect(screen.getByText('Chat access and subscriptions')).toBeDefined();
});
test('a saved singleton cannot be added again', () => {
  chat.surfaces = [
    { id: 'slack', surface: 'slack', botUserId: null, hasAppToken: true, hasBotToken: true },
  ];
  mount({}, '/w/connectors?view=catalog');
  expect(screen.getByRole('button', { name: 'Manage Slack' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Add Slack' })).toBeNull();
});
