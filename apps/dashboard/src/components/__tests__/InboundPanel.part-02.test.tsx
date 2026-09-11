// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SlackChannel, SurfaceSummary } from '../../lib/surfaces';
import { RequestError } from '../../lib/request-error';

import { installDialogMethods } from '../../test/dialog';

const h = vi.hoisted(() => ({
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
  test('manages channels: toggle an existing subscription and add a new one from the pick-list', async () => {
    h.surfaces = [surface({ hasBotToken: true })];
    // Stored rows keep the hashed display name we wrote; Slack's list is bare.
    h.listChannels.mockResolvedValue([{ channel: 'C_ALERTS', name: '#alerts', enabled: true }]);
    h.listAvailableChannels.mockResolvedValue({
      channels: [
        { id: 'C_ALERTS', name: 'alerts' },
        { id: 'C_OPS', name: 'ops' },
      ],
      truncated: false,
    });
    render(<InboundPanel embedded />);

    const box = (await screen.findByLabelText(/subscribe #alerts/i)) as HTMLInputElement;
    expect(box.checked).toBe(true);

    // Uncheck the enabled subscription — always by channel ID, never by display name. [D4]
    fireEvent.click(box);
    await waitFor(() => expect(h.toggleChannel).toHaveBeenCalled());
    const off = h.toggleChannel.mock.calls[0] as unknown as unknown[];
    expect(off[2]).toBe('C_ALERTS');
    expect(off[3]).toBe(false);

    // Subscribe a brand-new channel by PICKING it (an already-subscribed one is not offered). [D4/F3]
    const picker = await channelPicker();
    openPicker(picker); // the list loads on open, not on mount
    expect(await screen.findByRole('option', { name: '#ops' })).toBeDefined(); // bare "ops", hashed here
    fireEvent.change(picker, { target: { value: 'C_OPS' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(h.toggleChannel.mock.calls.length).toBeGreaterThan(1));
    const on = h.toggleChannel.mock.calls[1] as unknown as unknown[];
    expect(on[2]).toBe('C_OPS');
    expect(on[3]).toBe(true);
    expect(on[4]).toBe('#ops'); // the stored display name carries the '#'
  });

  test('shows Slack’s own refusal (the missing scope) rather than an empty channel list', async () => {
    h.surfaces = [surface({ hasBotToken: true })];
    h.listAvailableChannels.mockRejectedValue(
      new RequestError(
        'Slack rejected the request: missing_scope. The Slack app needs channels:read.',
        400,
      ),
    );
    render(<InboundPanel embedded />);
    // The refusal surfaces once the operator asks for the list (the fetch is lazy now).
    openPicker(await channelPicker());
    expect(await screen.findByText(/channels:read/)).toBeDefined();
  });

  // --- lazy fetch + truncation notice --------------------------------------------------------

  test('mounting the panel does NOT fetch the Slack channel list', async () => {
    h.surfaces = [surface({ hasBotToken: true })];
    h.listAvailableChannels.mockResolvedValue({
      channels: [{ id: 'C_OPS', name: 'ops' }],
      truncated: false,
    });
    render(<InboundPanel embedded />);

    // The subscribed-channel list still loads (it is what the page is FOR); conversations.list — a
    // Tier-2 rate-limited call that can walk 50 pages — must wait until the operator opens the picker.
    await waitFor(() => expect(h.listChannels).toHaveBeenCalled());
    expect(h.listAvailableChannels).not.toHaveBeenCalled();

    openPicker(await channelPicker());
    await waitFor(() => expect(h.listAvailableChannels).toHaveBeenCalledTimes(1));
  });

  test('re-opening the picker does not re-fetch (fetched once, in-flight guarded)', async () => {
    h.surfaces = [surface({ hasBotToken: true })];
    h.listAvailableChannels.mockResolvedValue({
      channels: [{ id: 'C_OPS', name: 'ops' }],
      truncated: false,
    });
    render(<InboundPanel embedded />);
    const picker = await channelPicker();

    openPicker(picker);
    openPicker(picker); // a second open while the first is still in flight
    await waitFor(() => expect(h.listAvailableChannels).toHaveBeenCalled());
    openPicker(picker); // and once it has resolved
    await waitFor(() => expect(screen.getByRole('option', { name: '#ops' })).toBeDefined());

    expect(h.listAvailableChannels).toHaveBeenCalledTimes(1);
  });

  test('a truncated list warns the operator that channels are missing from the picker', async () => {
    h.surfaces = [surface({ hasBotToken: true })];
    h.listAvailableChannels.mockResolvedValue({
      channels: [{ id: 'C_OPS', name: 'ops' }],
      truncated: true, // the API hit the page cap: the workspace has channels we never read
    });
    render(<InboundPanel embedded />);

    openPicker(await channelPicker());
    // Silence here means the operator hunts for a channel that simply is not in the list.
    expect(await screen.findByText(/truncated|not all channels|too many channels/i)).toBeDefined();
  });

  test('the "no channels visible" hint is hidden until the list has actually been read', async () => {
    h.surfaces = [surface({ hasBotToken: true })];
    h.listAvailableChannels.mockResolvedValue({ channels: [], truncated: false });
    render(<InboundPanel embedded />);

    // Before opening the picker an empty list means "not asked yet" — claiming the bot sees no channels
    // would be a lie, and it is the exact thing an operator would act on.
    const picker = await channelPicker();
    openPicker(picker);
    expect(await screen.findByText(/no channels visible to the bot yet/i)).toBeDefined();
  });

  test('a failed fetch is retryable: reopening the picker asks again', async () => {
    h.surfaces = [surface({ hasBotToken: true })];
    // The API's own rate-limit message tells the operator to wait and try again — so trying again must
    // actually do something. A once-guard that never resets on failure made the picker permanently dead.
    h.listAvailableChannels.mockRejectedValueOnce(
      new RequestError(
        'Slack rate-limited the channel list. Wait for the retry-after window…',
        429,
      ),
    );
    h.listAvailableChannels.mockResolvedValue({
      channels: [{ id: 'C_OPS', name: 'ops' }],
      truncated: false,
    });
    render(<InboundPanel embedded />);
    await channelPicker();

    expect(await screen.findByText(/rate-limited/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: '#ops' })).toBeDefined();
    expect(h.listAvailableChannels).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/rate-limited/i)).toBeNull(); // the stale error is cleared on success
  });

  test('a configured connection shows Edit and Disconnect with Socket Mode credential status only', async () => {
    h.surfaces = [
      surface({
        hasBotToken: true,
        hasAppToken: true,
      } as unknown as Partial<SurfaceSummary>),
    ];
    render(<InboundPanel embedded />);
    await screen.findByText('No channels subscribed yet.');

    const connection = screen.getByRole('region', { name: 'Slack connection' });
    expect(within(connection).getByRole('button', { name: /edit slack/i })).toBeDefined();
    expect(within(connection).getByRole('button', { name: /disconnect/i })).toBeDefined();
    expect(within(connection).getByText(/app token:\s*set/i)).toBeDefined();
    expect(within(connection).getByText(/bot token:\s*set/i)).toBeDefined();
    expect(within(connection).queryByText(/signing secret/i)).toBeNull();
    expect(within(connection).queryByText(/webhook url/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /connect slack/i })).toBeNull();

    fireEvent.click(within(connection).getByRole('button', { name: /edit slack/i }));
    expect(screen.getByRole('dialog', { name: 'Edit Slack' })).toBeDefined();
  });

  test('Disconnect requires confirmation, de-duplicates submission, and retains the visible connection on failure', async () => {
    h.surfaces = [surface({ hasAppToken: true } as unknown as Partial<SurfaceSummary>)];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<InboundPanel embedded />);
    await screen.findByText('No channels subscribed yet.');
    const connection = screen.getByRole('region', { name: 'Slack connection' });
    const disconnect = within(connection).getByRole('button', { name: /disconnect/i });

    fireEvent.click(disconnect);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(h.disconnectSlackSurface).not.toHaveBeenCalled();

    let rejectDisconnect!: (error: Error) => void;
    h.disconnectSlackSurface.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDisconnect = reject;
        }),
    );
    confirm.mockReturnValue(true);
    fireEvent.click(disconnect);
    fireEvent.click(disconnect);
    expect(h.disconnectSlackSurface).toHaveBeenCalledTimes(1);

    rejectDisconnect(new Error('disconnect failed'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/disconnect failed/i);
    expect(screen.getByRole('region', { name: 'Slack connection' })).toBeDefined();
  });

  test('successful Disconnect refetches into the empty state with Connect Slack', async () => {
    h.surfaces = [surface({ hasAppToken: true, hasBotToken: true })];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.refetch.mockImplementationOnce(async () => {
      h.surfaces = [];
    });
    render(<InboundPanel embedded />);
    await screen.findByText('No channels subscribed yet.');

    fireEvent.click(
      within(screen.getByRole('region', { name: 'Slack connection' })).getByRole('button', {
        name: /disconnect/i,
      }),
    );

    await waitFor(() => expect(h.disconnectSlackSurface).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.refetch).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Slack is not connected yet.')).toBeDefined();
    expect(screen.getByRole('button', { name: /connect slack/i })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Slack connection' })).toBeNull();
  });

  test('a complete list shows no truncation notice', async () => {
    h.surfaces = [surface({ hasBotToken: true })];
    h.listAvailableChannels.mockResolvedValue({
      channels: [{ id: 'C_OPS', name: 'ops' }],
      truncated: false,
    });
    render(<InboundPanel embedded />);

    openPicker(await channelPicker());
    await waitFor(() => expect(screen.getByRole('option', { name: '#ops' })).toBeDefined());
    expect(screen.queryByText(/truncated|not all channels|too many channels/i)).toBeNull();
  });
});
