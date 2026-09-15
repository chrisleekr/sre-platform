// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SlackChannel, SurfaceSummary } from '../../lib/surfaces';

import { installDialogMethods } from '../../test/dialog';

const h = vi.hoisted(() => ({
  role: 'admin' as string | undefined,
  impersonation: null as object | null,
  surfaces: [] as SurfaceSummary[],
  loading: false,
  error: false,
  refetch: vi.fn(),
  listChannels: vi.fn(async () => [] as SlackChannel[]),
  // the channels Slack itself reports (conversations.list) — the pick-list source.
  // it now answers { channels, truncated } — the page cap silently dropped channels past page 50
  // and the operator had no way to know the picker was incomplete.
  listAvailableChannels: vi.fn(async () => ({
    channels: [] as { id: string; name: string }[],
    truncated: false,
  })),
  toggleChannel: vi.fn(async () => {}),
  disconnectSlackSurface: vi.fn(async () => {}),
}));

// The shared auth boundary is a hard dependency of the panel; stub it so the hook wiring doesn't run.
vi.mock('../../lib/me-store', () => ({
  useMe: () => ({ data: { tenant: { role: h.role, impersonation: h.impersonation } } }),
}));

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'tok' }) }),
}));

vi.mock('../../lib/useSurfaces', () => ({
  useSurfaces: () => ({
    surfaces: h.surfaces,
    loading: h.loading,
    error: h.error,
    refetch: h.refetch,
  }),
  saveSlackSurface: vi.fn(async () => {}),
  testSlackSurface: vi.fn(async () => ({ ok: true, botUserId: 'U0BOT', team: 'T0' })),
  listChannels: h.listChannels,
  listAvailableChannels: h.listAvailableChannels,
  toggleChannel: h.toggleChannel,
  disconnectSlackSurface: h.disconnectSlackSurface,
}));

import { InboundPanel } from '../InboundPanel';

let dialogMethods: ReturnType<typeof installDialogMethods>;

beforeEach(() => {
  h.role = 'admin';
  h.impersonation = null;
  dialogMethods = installDialogMethods();
});

const surface = (over?: Partial<SurfaceSummary>): SurfaceSummary => ({
  id: 'srf-1',
  surface: 'slack',
  botUserId: 'U0BOT',
  hasAppToken: true,
  hasBotToken: true,
  ...over,
});

afterEach(() => {
  cleanup();
  dialogMethods.restore();
  h.surfaces = [];
  h.loading = false;
  h.error = false;
  h.refetch.mockReset();
  h.listChannels.mockReset();
  h.listChannels.mockResolvedValue([]);
  h.listAvailableChannels.mockReset();
  h.listAvailableChannels.mockResolvedValue({ channels: [], truncated: false });
  h.toggleChannel.mockReset();
  h.toggleChannel.mockResolvedValue(undefined);
  h.disconnectSlackSurface.mockReset();
  h.disconnectSlackSurface.mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

// the list is fetched LAZILY, when the operator opens the picker — not on mount. Opening is a
// focus (keyboard) or a click (mouse) on the select; fire both so either wiring satisfies the test.
const openPicker = (picker: HTMLElement): void => {
  fireEvent.focus(picker);
  fireEvent.click(picker);
};

async function channelPicker() {
  if (!screen.queryByRole('dialog', { name: 'Add channel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
  return screen.findByLabelText(/channel to subscribe/i);
}

describe('InboundPanel', () => {
  test.each(['classify_enqueued', 'mention_enqueued', 'edit_enqueued'])(
    'shows downstream classification as pending for %s',
    (outcome) => {
      h.surfaces = [
        surface({
          runtime: {
            socket: null,
            inbound: {
              latest: {
                state: 'processed',
                outcome,
                classificationOutcome: null,
                classificationUpdatedAt: null,
                acceptedAt: '2026-08-29T08:01:00.000Z',
                completedAt: '2026-08-29T08:01:01.000Z',
                jobStatus: 'done',
                attemptCount: 1,
                errorCode: null,
              },
              pendingCount: 1,
              failedLast24Hours: 0,
            },
          },
        }),
      ];

      render(<InboundPanel embedded />);

      expect(screen.getByText(/Latest event: Classification queued/)).toBeDefined();
      expect(screen.getByText(/1 inbound event pending/)).toBeDefined();
    },
  );

  test('renders the Connect Slack button', () => {
    render(<InboundPanel embedded />);
    expect(screen.getByRole('button', { name: /connect slack/i })).toBeDefined();
  });

  test('shows live Socket Mode state and the last durable inbound outcome', () => {
    h.surfaces = [
      surface({
        runtime: {
          socket: {
            state: 'connected',
            connectedAt: '2026-08-29T08:00:00.000Z',
            updatedAt: '2026-08-29T08:00:00.000Z',
          },
          inbound: {
            latest: {
              state: 'processed',
              outcome: 'resume_enqueued',
              classificationOutcome: 'provider_alert_opened',
              classificationUpdatedAt: '2026-08-29T08:01:02.000Z',
              acceptedAt: '2026-08-29T08:01:00.000Z',
              completedAt: '2026-08-29T08:01:01.000Z',
              jobStatus: 'done',
              attemptCount: 1,
              errorCode: null,
            },
            pendingCount: 0,
            failedLast24Hours: 0,
          },
        },
      }),
    ];

    render(<InboundPanel embedded />);

    expect(screen.getByText('Connected')).toBeDefined();
    expect(screen.getByText(/Latest event: Incident opened/)).toBeDefined();
    expect(screen.getByText(/provider alert started an investigation/i)).toBeDefined();
  });

  test('shows the terminal classification instead of the original enqueue outcome', () => {
    h.surfaces = [
      surface({
        runtime: {
          socket: null,
          inbound: {
            latest: {
              state: 'processed',
              outcome: 'classify_enqueued',
              classificationOutcome: 'new_incident',
              classificationUpdatedAt: '2026-08-29T08:01:02.000Z',
              acceptedAt: '2026-08-29T08:01:00.000Z',
              completedAt: '2026-08-29T08:01:01.000Z',
              jobStatus: 'done',
              attemptCount: 1,
              errorCode: null,
            },
            pendingCount: 0,
            failedLast24Hours: 0,
          },
        },
      }),
    ];

    render(<InboundPanel embedded />);

    expect(screen.getByText(/Latest event: Incident opened/)).toBeDefined();
    expect(screen.queryByText(/Latest event: Classification queued/)).toBeNull();
  });

  test('shows a durable adapter suppression instead of queued classification', () => {
    h.surfaces = [
      surface({
        runtime: {
          socket: null,
          inbound: {
            latest: {
              state: 'processed',
              outcome: 'classify_enqueued',
              classificationOutcome: 'provider_alert_opened',
              classificationUpdatedAt: '2026-08-29T08:01:01.500Z',
              terminalDisposition: 'suppressed_provider_control_notification',
              terminalDispositionAt: '2026-08-29T08:01:02.000Z',
              terminalDispositionEventAt: '2026-08-29T08:01:01.750Z',
              acceptedAt: '2026-08-29T08:01:00.000Z',
              completedAt: '2026-08-29T08:01:01.000Z',
              jobStatus: 'done',
              attemptCount: 1,
              errorCode: null,
            },
            pendingCount: 0,
            failedLast24Hours: 0,
          },
        },
      }),
    ];

    render(<InboundPanel embedded />);

    expect(screen.getByText(/Latest event: Control notification suppressed/)).toBeDefined();
    expect(screen.getByText(/non-actionable provider control notification/i)).toBeDefined();
    expect(screen.queryByText(/Latest event: Classification queued/)).toBeNull();
    expect(screen.queryByText(/Latest event: Incident opened/)).toBeNull();
  });

  test('shows dead-lettered intake as a terminal failure rather than pending work', () => {
    h.surfaces = [
      surface({
        runtime: {
          socket: null,
          inbound: {
            latest: {
              state: 'retrying',
              outcome: 'processing_failed',
              classificationOutcome: null,
              classificationUpdatedAt: null,
              acceptedAt: '2026-08-29T08:01:00.000Z',
              completedAt: null,
              jobStatus: 'dead',
              attemptCount: 50,
              errorCode: 'dependency_failure',
            },
            pendingCount: 0,
            failedLast24Hours: 1,
          },
        },
      }),
    ];

    render(<InboundPanel embedded />);

    expect(screen.getByText(/Latest event: Delivery failed/)).toBeDefined();
    expect(screen.queryByText(/inbound event.*pending/)).toBeNull();
    expect(screen.getByText(/1 failed or retrying/)).toBeDefined();
  });

  test('explains an untracked Slack edit without presenting it as a connector failure', () => {
    h.surfaces = [
      surface({
        runtime: {
          socket: null,
          inbound: {
            latest: {
              state: 'dropped',
              outcome: 'dropped_untracked_edit',
              classificationOutcome: null,
              classificationUpdatedAt: null,
              acceptedAt: '2026-08-29T08:01:00.000Z',
              completedAt: '2026-08-29T08:01:01.000Z',
              jobStatus: 'done',
              attemptCount: 1,
              errorCode: null,
            },
            pendingCount: 0,
            failedLast24Hours: 0,
          },
        },
      }),
    ];

    render(<InboundPanel embedded />);

    expect(screen.getByText(/Latest event: Edit ignored/)).toBeDefined();
    expect(screen.getByText(/not attached to a tracked incident/i)).toBeDefined();
  });

  test('explains a non-actionable Slack envelope without exposing a worker code', () => {
    h.surfaces = [
      surface({
        runtime: {
          socket: null,
          inbound: {
            latest: {
              state: 'dropped',
              outcome: 'dropped_no_candidate',
              classificationOutcome: null,
              classificationUpdatedAt: null,
              acceptedAt: '2026-08-29T08:01:00.000Z',
              completedAt: '2026-08-29T08:01:01.000Z',
              jobStatus: 'done',
              attemptCount: 1,
              errorCode: null,
            },
            pendingCount: 0,
            failedLast24Hours: 0,
          },
        },
      }),
    ];

    render(<InboundPanel embedded />);

    expect(screen.getByText(/Latest event: No incident action/)).toBeDefined();
    expect(screen.getByText(/did not match an incident-opening signal/i)).toBeDefined();
    expect(screen.queryByText(/dropped no candidate/i)).toBeNull();
  });

  test('opens Slack setup in the shared constrained native dialog', async () => {
    render(<InboundPanel embedded />);
    const trigger = screen.getByRole('button', { name: /connect slack/i });

    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Connect Slack' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialogMethods.showModal).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByLabelText(/app token/i)).toBeDefined();
    expect(dialog.className).toMatch(/max-w-/);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('heading', { name: 'Connect Slack' }),
      ),
    );
  });

  test('closing restores the exact Slack trigger when later channel controls exist', async () => {
    h.surfaces = [surface()];
    h.listChannels.mockResolvedValue([{ channel: 'C_ALERTS', name: '#alerts', enabled: true }]);
    render(<InboundPanel embedded />);
    await screen.findByRole('button', { name: 'Add channel' });
    const trigger = screen.getByRole('button', { name: /edit slack/i });

    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Edit Slack' })).getByRole('button', {
        name: 'Cancel',
      }),
    );

    expect(h.refetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('uses one page heading and preserves the Connect Slack action (C7)', () => {
    render(<InboundPanel embedded />);

    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Chat access and subscriptions' }),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: /connect slack/i })).toBeDefined();
  });

  test('renders a reserved, polite first-load state (C1)', () => {
    h.loading = true;
    const { container } = render(<InboundPanel embedded />);

    expect(container.querySelector('[data-page-state="loading"]')?.className).toMatch(/min-h-/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading inbound/i);
  });

  test('keeps the saved connection visible and announces an explicit refresh', () => {
    h.surfaces = [surface({ hasBotToken: false })];
    const view = render(<InboundPanel embedded />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('');

    h.loading = true;
    view.rerender(<InboundPanel embedded />);

    expect(screen.getByRole('region', { name: 'Slack connection' })).toBeDefined();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/refreshing inbound connection/i);
    expect(screen.queryByText('Loading inbound…')).toBeNull();
  });

  test('explains the empty inbound connection in context (C2)', () => {
    render(<InboundPanel embedded />);

    expect(screen.getByText('Slack is not connected yet.')).toBeDefined();
    expect(screen.getByText(/connect slack.*receive incidents/i)).toBeDefined();
  });

  test('renders one specific error and retries through the existing hook (C3, C6)', () => {
    h.error = true;
    render(<InboundPanel embedded />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toMatch(/failed to load the slack connection/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  test('keeps the Slack connection visible when a refresh fails (C3, C6)', () => {
    h.surfaces = [surface({ id: 'srf-retained' })];
    h.error = true;
    render(<InboundPanel embedded />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Slack connection' })).toBeDefined();
    expect(screen.queryByText('Slack is not connected yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  // The connection has no target and no enable flag: the row's existence is the connection.
  test('renders the connected Slack row without HTTP webhook guidance', () => {
    h.surfaces = [surface({ id: 'srf-abc' })];
    render(<InboundPanel embedded />);
    expect(screen.getByText('Slack')).toBeDefined();
    expect(screen.queryByText(/webhook url/i)).toBeNull();
  });

  test('renders secret-presence status labels but never secret material', () => {
    // The hook only ever hands the panel hasAppToken/hasBotToken presence booleans; a real
    // secret string must never reach the DOM. [D5, write-only]
    h.surfaces = [surface({ hasAppToken: true, hasBotToken: true })];
    const { container } = render(<InboundPanel embedded />);
    expect(screen.getByText(/app token: set/i)).toBeDefined();
    expect(screen.getByText(/bot token: set/i)).toBeDefined();
    expect(container.textContent).not.toContain('xoxb-');
    expect(container.textContent).not.toContain('xapp-');
  });

  test('separates truthful Slack connection configuration from channel subscriptions (261-C2)', async () => {
    h.surfaces = [surface({ botUserId: 'U0BOT', hasAppToken: true, hasBotToken: true })];
    h.listChannels.mockResolvedValue([{ channel: 'C_ALERTS', name: '#alerts', enabled: true }]);

    render(<InboundPanel embedded />);

    expect(await screen.findByLabelText(/subscribe #alerts/i)).toBeDefined();
    const connection = screen.getByRole('region', { name: 'Slack connection' });
    const subscriptions = screen.getByRole('region', { name: 'Channel subscriptions' });
    expect(within(connection).getByText('Configured')).toBeDefined();
    expect(within(connection).getByText(/Last verified identity:\s*U0BOT/i)).toBeDefined();
    expect(within(connection).queryByText(/webhook url/i)).toBeNull();
    expect(within(subscriptions).getByLabelText(/subscribe #alerts/i)).toBeDefined();
    expect(within(connection).queryByText(/healthy|unhealthy|connected as/i)).toBeNull();
  });

  test('requires both credential-presence flags before claiming Slack is Configured', () => {
    h.surfaces = [surface({ botUserId: 'U0BOT', hasAppToken: true, hasBotToken: false })];

    render(<InboundPanel embedded />);

    const connection = screen.getByRole('region', { name: 'Slack connection' });
    expect(within(connection).getByText('Needs configuration')).toBeDefined();
    expect(within(connection).queryByText('Configured')).toBeNull();
    expect(within(connection).getByText(/Last verified identity:\s*U0BOT/i)).toBeDefined();
  });

  test('never renders secret-shaped opaque fields even if a malformed projection includes them', () => {
    h.surfaces = [
      {
        ...surface(),
        appToken: 'xapp-must-not-render',
        botToken: 'xoxb-must-not-render',
      } as SurfaceSummary,
    ];

    const { container } = render(<InboundPanel embedded />);

    expect(container.textContent).not.toContain('xapp-must-not-render');
    expect(container.textContent).not.toContain('xoxb-must-not-render');
  });

  test('keeps both connection and subscription regions min-width safe at compact widths', async () => {
    h.surfaces = [surface()];
    const { container } = render(<InboundPanel embedded />);
    await screen.findByText('No channels subscribed yet.');
    const connection = screen.getByRole('region', { name: 'Slack connection' });
    const subscriptions = screen.getByRole('region', { name: 'Channel subscriptions' });

    expect(connection.className).toMatch(/min-w-0/);
    expect(subscriptions.className).toMatch(/min-w-0/);
    expect(container.querySelector('ul')?.className).toMatch(/grid|flex/);
  });

  // --- pick a channel, never type one -------------------------------------------------------
  // Slack events carry channel IDs (C07…); a typed "#name" can never match, so every inbound alert was
  // acked and silently dropped. The operator picks from the channels Slack reports; we store the ID.

  // The API hands back Slack's own name, VERBATIM and unhashed ("ops"); the '#' is presentation and the
  // panel adds it. Fixtures that arrive pre-hashed would make hashed() dead code the tests never exercise,
  // and the operator would read a bare "ops" in production.
  test('subscribes a channel by picking it from the Slack channel list, storing the id', async () => {
    h.surfaces = [surface({ hasBotToken: true })];
    h.listChannels.mockResolvedValue([]);
    h.listAvailableChannels.mockResolvedValue({
      channels: [{ id: 'C07EWAS8132', name: 'homelab-notification' }], // as the API returns: no '#'
      truncated: false,
    });
    render(<InboundPanel embedded />);

    const picker = (await channelPicker()) as HTMLElement;
    expect(picker.tagName).toBe('SELECT'); // a pick-list, not a free-text box
    openPicker(picker);
    // The panel hashes for display: the operator reads "#homelab-notification", not "homelab-notification".
    expect(await screen.findByRole('option', { name: '#homelab-notification' })).toBeDefined();

    fireEvent.change(picker, { target: { value: 'C07EWAS8132' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(h.toggleChannel).toHaveBeenCalled());
    const args = h.toggleChannel.mock.calls[0] as unknown as unknown[];
    expect(args[2]).toBe('C07EWAS8132'); // the ID Slack events carry — never the display name
    // The stored display name is hashed too, so the dashboard's incident groups read "#name".
    expect(args[4]).toBe('#homelab-notification');
  });

  test('the inbound page has no post-to-channel field and never says "Surface"', () => {
    h.surfaces = [surface({ hasBotToken: true })];
    const { container } = render(<InboundPanel embedded />);

    // The AI answers in the alert's own thread, so there is no channel to configure.
    fireEvent.click(screen.getByRole('button', { name: /edit slack/i }));
    expect(screen.queryByLabelText(/channel to post to/i)).toBeNull();
    // The page is about INBOUND, in the operator's words — "Surface" is our internal jargon.
    expect(container.textContent).not.toMatch(/surface/i);
    expect(container.textContent).toMatch(/inbound/i);
  });
});
