// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SlackChannel, SurfaceSummary } from '../../../lib/surfaces';
import { installDialogMethods } from '../../../test/dialog';
import { InboundOverview } from '../InboundOverview';
import { inboundOutcomePresentation } from '../outcome';

const h = vi.hoisted(() => ({
  surfaces: [] as SurfaceSummary[],
  error: false,
  channels: vi.fn(async (): Promise<SlackChannel[]> => []),
  available: vi.fn(async () => ({ channels: [{ id: 'COPS', name: 'ops' }], truncated: false })),
  update: vi.fn(async () => {}),
  refetch: vi.fn(),
  credentials: async () => ({ kind: 'bearer' as const, token: 'test' }),
}));
vi.mock('../../../auth', () => ({ useSession: () => ({ getCredentials: h.credentials }) }));
vi.mock('../../../lib/useSurfaces', () => ({
  useSurfaces: () => ({ surfaces: h.surfaces, loading: false, error: h.error, refetch: h.refetch }),
  listChannels: h.channels,
  listAvailableChannels: h.available,
  toggleChannel: h.update,
}));
let dialog: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialog = installDialogMethods();
  h.surfaces = [
    { id: 'slack', surface: 'slack', hasAppToken: true, hasBotToken: true, botUserId: 'UBOT' },
  ];
});
afterEach(() => {
  cleanup();
  dialog.restore();
  h.error = false;
  vi.clearAllMocks();
  h.channels.mockResolvedValue([]);
  h.update.mockResolvedValue(undefined);
});
const mount = () =>
  render(
    <MemoryRouter>
      <InboundOverview />
    </MemoryRouter>,
  );

test.each([
  ['queued', 'Message queued'],
  ['processing', 'Processing message'],
] as const)('unclassified %s receipts are not reported as processed', (state, label) => {
  const latest = {
    state,
    outcome: null,
    classificationOutcome: null,
    classificationUpdatedAt: null,
    terminalDisposition: null,
    acceptedAt: '2026-09-08T10:00:00Z',
    completedAt: null,
    jobStatus: 'pending',
    attemptCount: 1,
    errorCode: null,
  };
  expect(inboundOutcomePresentation(latest).label).toBe(label);
  expect(inboundOutcomePresentation({ ...latest, jobStatus: 'dead' }).label).toBe(
    'Delivery failed',
  );
  expect(inboundOutcomePresentation({ ...latest, terminalDisposition: 'new_incident' }).label).toBe(
    'Incident opened',
  );
});

test('shows intake controls, not a second credential form', async () => {
  mount();
  await screen.findByText('No channels subscribed yet.');
  expect(screen.getByRole('link', { name: 'Manage Slack connection' }).getAttribute('href')).toBe(
    '/w/connectors?connection=slack',
  );
  expect(screen.queryByRole('button', { name: 'Edit Slack' })).toBeNull();
  expect(screen.queryByText('App token: set')).toBeNull();
  expect(h.available).not.toHaveBeenCalled();
  expect(screen.getByText('Processing counts are not available yet.')).toBeDefined();
});
test('does not turn a failed initial load into an empty intake state', () => {
  h.surfaces = [];
  h.error = true;
  mount();
  expect(screen.getByRole('alert')).toBeDefined();
  expect(screen.queryByText('Connect a chat tool to get started.')).toBeNull();
});
test('failed adds are retryable and never appear as listening', async () => {
  h.update.mockRejectedValueOnce(new Error('network error'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
  await screen.findByRole('option', { name: '#ops' });
  fireEvent.change(screen.getByLabelText('Channel to subscribe'), { target: { value: 'COPS' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('checkbox', { name: 'Subscribe #ops' })).toBeNull();
  expect(screen.getByLabelText('Channel to subscribe')).toHaveProperty('value', 'COPS');
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(await screen.findByRole('checkbox', { name: 'Subscribe #ops' })).toHaveProperty(
    'checked',
    true,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});
test('failed changes retain server-confirmed state and prevent concurrent writes', async () => {
  h.channels.mockResolvedValue([{ channel: 'COPS', name: '#ops', enabled: true }]);
  let reject!: (e: Error) => void;
  h.update.mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  mount();
  const checkbox = await screen.findByRole('checkbox', { name: 'Subscribe #ops' });
  fireEvent.click(checkbox);
  fireEvent.click(checkbox);
  expect(h.update).toHaveBeenCalledTimes(1);
  expect(checkbox).toHaveProperty('checked', true);
  expect(checkbox).toHaveProperty('disabled', true);
  reject(new Error('failed'));
  await screen.findByRole('alert');
  expect(checkbox).toHaveProperty('checked', true);
  await waitFor(() => expect(checkbox).toHaveProperty('disabled', false));
});
test('search and status filters work without querying Slack again', async () => {
  h.channels.mockResolvedValue([
    { channel: 'COPS', name: '#ops', enabled: true },
    { channel: 'CDEV', name: '#dev', enabled: false },
  ]);
  mount();
  await screen.findByRole('checkbox', { name: 'Subscribe #ops' });
  fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Paused' } });
  expect(screen.queryByRole('checkbox', { name: 'Subscribe #ops' })).toBeNull();
  expect(
    within(screen.getByRole('region', { name: 'Channel subscriptions' })).getByText('#dev'),
  ).toBeDefined();
  expect(h.available).not.toHaveBeenCalled();
});
