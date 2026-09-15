import { useCallback, useEffect, useRef, useState } from 'react';
import type { CredentialGetter } from '../lib/request-credentials';
import { config } from '../config';
import { requestErrorMessage } from '../lib/request-error';
import type { AvailableChannel, SlackChannel } from '../lib/surfaces';
import { listAvailableChannels, listChannels, toggleChannel } from '../lib/useSurfaces';
import { InlineAlert, StatePanel } from './PageState';
import { SetupDialog } from './SetupDialog';

const hashed = (name: string): string => (name.startsWith('#') ? name : '#' + name);

/** Channel identity comes from Slack; a display name must never be used as an event key. */
export function ChannelManager({
  getCredentials,
  canConfigure,
}: {
  getCredentials: CredentialGetter;
  canConfigure: boolean;
}) {
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [available, setAvailable] = useState<AvailableChannel[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [picked, setPicked] = useState('');
  const [search, setSearch] = useState('');
  const [channelSearch, setChannelSearch] = useState('');
  const [filter, setFilter] = useState('All channels');
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const pendingRef = useRef(new Set<string>());
  const requested = useRef(false);
  const [asked, setAsked] = useState(false);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    void listChannels(config.apiBaseUrl, getCredentials)
      .then((list) => {
        if (active) setChannels(list);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [getCredentials, revision]);

  // Opening Add channel is the only action that enumerates Slack's rate-limited directory.
  const openPicker = useCallback(() => {
    if (requested.current) return;
    requested.current = true;
    setAvailableLoading(true);
    setAvailableError(null);
    void listAvailableChannels(config.apiBaseUrl, getCredentials)
      .then((result) => {
        if (!alive.current) return;
        setAvailable(result.channels);
        setTruncated(result.truncated);
        setAsked(true);
      })
      .catch((err: unknown) => {
        requested.current = false;
        if (alive.current)
          setAvailableError(requestErrorMessage(err, 'Slack channel discovery failed.'));
      })
      .finally(() => {
        if (alive.current) setAvailableLoading(false);
      });
  }, [getCredentials]);

  const update = async (
    channel: string,
    name: string | null,
    enabled: boolean,
    isNew = false,
  ): Promise<void> => {
    if (pendingRef.current.has(channel)) return;
    pendingRef.current.add(channel);
    setPending([...pendingRef.current]);
    setMutationError(null);
    try {
      await toggleChannel(config.apiBaseUrl, getCredentials, channel, enabled, name ?? undefined);
      if (!alive.current) return;
      setChannels((current) =>
        current.some((c) => c.channel === channel)
          ? current.map((c) => (c.channel === channel ? { ...c, enabled } : c))
          : [...current, { channel, name, enabled }],
      );
      if (isNew) {
        setAdding(false);
        setPicked('');
      }
    } catch (cause) {
      if (alive.current)
        setMutationError(
          requestErrorMessage(
            cause,
            'Could not confirm the update to ' +
              (name ?? channel) +
              '. Showing the last confirmed subscription. Try again.',
          ),
        );
    } finally {
      pendingRef.current.delete(channel);
      if (alive.current) setPending([...pendingRef.current]);
    }
  };
  const visible = channels.filter(
    (c) =>
      (filter === 'All channels' || (filter === 'Listening' ? c.enabled : !c.enabled)) &&
      (c.name ?? c.channel).toLowerCase().includes(search.trim().toLowerCase()),
  );
  const subscribable = available.filter(
    (a) =>
      !channels.some((c) => c.channel === a.id) &&
      hashed(a.name).toLowerCase().includes(channelSearch.trim().toLowerCase()),
  );
  return (
    <section aria-label="Channel subscriptions" className="min-w-0">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Channel subscriptions</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Listening channels allow new messages into incident intake. Pause a channel to stop new
            intake without disconnecting Slack.
          </p>
        </div>
        <button
          ref={addTrigger}
          type="button"
          disabled={!canConfigure || loading || error}
          onClick={() => {
            setMutationError(null);
            setAdding(true);
            openPicker();
          }}
          className="min-h-10 rounded-md bg-strong px-3 py-2 text-sm font-semibold text-on-strong disabled:opacity-50"
        >
          Add channel
        </button>
      </header>
      {loading && channels.length > 0 && (
        <p role="status" className="mb-3 text-sm text-ink-muted">
          Refreshing channels…
        </p>
      )}
      {error && (
        <InlineAlert
          message="Failed to load channels. Previously loaded subscriptions may be outdated."
          onRetry={() => setRevision((r) => r + 1)}
        />
      )}
      {mutationError && !adding && <InlineAlert message={mutationError} />}
      {loading && channels.length === 0 ? (
        <StatePanel state="loading" title="Loading channels…" />
      ) : (
        <>
          {channels.length > 0 && (
            <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="text-sm font-medium">
                Search subscriptions
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Channel name"
                  className="mt-1 block w-full rounded-md border border-line-strong bg-surface px-3 py-2.5"
                />
              </label>
              <label className="text-sm font-medium">
                Status
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-line-strong bg-surface px-3 py-2.5"
                >
                  {['All channels', 'Listening', 'Paused'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {!error && channels.length === 0 && (
            <StatePanel
              state="empty"
              title="No channels subscribed yet."
              description="Choose Add channel, select a channel the bot can see, and confirm. Other channels are not subscribed automatically."
            />
          )}
          {channels.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              <ul className="divide-y divide-line">
                {visible.map((ch) => (
                  <li
                    key={ch.channel}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-4 p-4"
                  >
                    <div className="min-w-0">
                      <p className="break-all font-medium">
                        {ch.name ? hashed(ch.name) : ch.channel}
                      </p>
                      <p className="mt-1 text-xs text-ink-muted">
                        {pending.includes(ch.channel)
                          ? 'Saving…'
                          : ch.enabled
                            ? 'Listening'
                            : 'Paused'}
                      </p>
                    </div>
                    <label className="flex min-h-10 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={ch.enabled}
                        disabled={!canConfigure || pending.includes(ch.channel) || loading || error}
                        onChange={(e) => void update(ch.channel, ch.name, e.target.checked)}
                        aria-label={'Subscribe ' + (ch.name ? hashed(ch.name) : ch.channel)}
                      />
                      Listen
                    </label>
                  </li>
                ))}
              </ul>
              {visible.length === 0 && (
                <p className="p-5 text-sm text-ink-muted">
                  No matching subscriptions. Try another search or status.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {canConfigure && adding && (
        <SetupDialog
          title="Add channel"
          size="standard"
          closeLabel="Cancel"
          busy={pending.length > 0}
          returnFocusTo={addTrigger.current}
          onClose={() => setAdding(false)}
        >
          <p className="mb-4 text-sm text-ink-muted">
            Select a channel from Slack. Invite the bot to private channels before adding them.
          </p>
          {availableLoading && (
            <p role="status" className="mb-3 text-sm text-ink-muted">
              Loading channels from Slack…
            </p>
          )}
          {availableError && <InlineAlert message={availableError} onRetry={openPicker} />}
          {mutationError && <InlineAlert message={mutationError} />}
          <label className="block text-sm font-medium">
            Find a channel
            <input
              type="search"
              value={channelSearch}
              onChange={(e) => {
                setChannelSearch(e.target.value);
                setPicked('');
              }}
              className="mt-1 mb-4 block w-full rounded-md border border-line-strong bg-surface px-3 py-2.5"
            />
          </label>
          <label className="block text-sm font-medium">
            Channel to subscribe
            <select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="mt-1 block w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 py-2.5"
            >
              <option value="">Choose a channel…</option>
              {subscribable.map((a) => (
                <option key={a.id} value={a.id}>
                  {hashed(a.name)}
                </option>
              ))}
            </select>
          </label>
          {truncated && (
            <p className="mt-3 text-sm text-warning">
              The Slack channel list is truncated. Some channels may be missing. Invite the bot to
              the channel you need or ask your Slack administrator to check access.
            </p>
          )}
          {asked && !availableError && available.length === 0 && (
            <p className="mt-3 text-sm text-ink-muted">
              No channels visible to the bot yet. Invite it to a channel first.
            </p>
          )}
          {asked && available.length > 0 && subscribable.length === 0 && (
            <p className="mt-3 text-sm text-ink-muted">
              No matching channels to add. Try another search; channels already subscribed are
              excluded.
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              disabled={!picked || availableLoading || !!availableError || pending.length > 0}
              onClick={() => {
                const chosen = subscribable.find((a) => a.id === picked);
                if (chosen) void update(chosen.id, hashed(chosen.name), true, true);
              }}
              className="mt-5 min-h-10 rounded-md bg-strong px-4 py-2 text-sm font-semibold text-on-strong disabled:opacity-50"
            >
              {pending.length > 0 ? 'Adding…' : 'Add'}
            </button>
          </SetupActions>
        </SetupDialog>
      )}
    </section>
  );
}
import { SetupActions } from './SetupDialogSlots';
