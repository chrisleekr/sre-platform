import { useMe } from '../lib/me-store';
import type { CredentialGetter } from '../lib/request-credentials';
import { useCallback, useRef, useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import type { SurfaceSummary } from '../lib/surfaces';
import { formatAbsoluteTime } from '../lib/time';
import {
  disconnectSlackSurface,
  saveSlackSurface,
  testSlackSurface,
  useSurfaces,
} from '../lib/useSurfaces';
import { PageHeader } from './PageHeader';
import { InlineAlert, StatePanel } from './PageState';
import { SlackConnectWizard } from './SlackConnectWizard';

import { inboundOutcomePresentation } from './inbound/outcome';
import { InboundOverview } from './inbound/InboundOverview';

import { ChannelManager } from './InboundChannelManager';

function SlackConfiguration({
  surface,
  canConfigure,
  getCredentials,
  onEdit,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  surface: SurfaceSummary;
  canConfigure: boolean;
  getCredentials: CredentialGetter;
  onEdit: (trigger: HTMLButtonElement) => void;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const configured = surface.hasAppToken && surface.hasBotToken;
  const socketState = surface.runtime?.socket?.state;
  let status = 'Configured';
  if (!configured) status = 'Needs configuration';
  else if (socketState === 'connected') status = 'Connected';
  else if (socketState === 'connecting' || socketState === 'reconnecting') status = 'Reconnecting';
  else if (socketState === 'disconnected') status = 'Connection unavailable';
  const healthy = status === 'Connected' || status === 'Configured';
  const inbound = surface.runtime?.inbound;
  const latestInbound = inbound?.latest;
  const inboundPresentation = inboundOutcomePresentation(latestInbound ?? null);
  const pendingCount = inbound?.pendingCount ?? 0;
  const failedCount = inbound?.failedLast24Hours ?? 0;
  const connectionTitleId = `slack-connection-${surface.id}`;
  return (
    <li className="grid min-w-0 gap-5">
      <section
        aria-labelledby={connectionTitleId}
        className="flex min-w-0 flex-col gap-2 rounded border border-line bg-surface p-4"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h2 id={connectionTitleId} className="font-medium">
            <span>Slack</span>
            <span> connection</span>
          </h2>
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              healthy ? 'bg-success-muted text-success' : 'bg-warning-muted text-warning'
            }`}
          >
            {status}
          </span>
        </div>
        {/* Presence booleans only; a secret value is never projected by the API or rendered. [D5] */}
        <div className="flex min-w-0 flex-wrap gap-2 text-xs text-ink-muted">
          <span>App token: {surface.hasAppToken ? 'set' : 'missing'}</span>
          <span>Bot token: {surface.hasBotToken ? 'set' : 'missing'}</span>
        </div>
        {surface.botUserId && (
          <p className="break-words text-xs text-ink-muted">
            Last verified identity: {surface.botUserId}
          </p>
        )}
        {latestInbound ? (
          <div className="rounded-md bg-surface-subtle p-3 text-xs text-ink-muted">
            <p
              className={`font-semibold ${
                inboundPresentation.tone === 'critical'
                  ? 'text-critical'
                  : inboundPresentation.tone === 'warning'
                    ? 'text-warning'
                    : 'text-ink-secondary'
              }`}
            >
              Latest event: {inboundPresentation.label}
            </p>
            <p className="mt-1">{inboundPresentation.detail}</p>
            <time dateTime={latestInbound.acceptedAt} className="mt-1 block text-ink-faint">
              {formatAbsoluteTime(latestInbound.acceptedAt)}
            </time>
            {pendingCount > 0 && (
              <p className="text-warning">
                {pendingCount} inbound event{pendingCount === 1 ? '' : 's'} pending
              </p>
            )}
            {failedCount > 0 && (
              <p className="text-critical">{failedCount} failed or retrying in the last 24 hours</p>
            )}
          </div>
        ) : configured ? (
          <p className="text-xs text-ink-muted">No inbound events recorded yet.</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canConfigure}
            onClick={(event) => onEdit(event.currentTarget)}
            className="rounded border border-line-strong px-2 py-1 text-xs font-medium hover:bg-surface-subtle disabled:opacity-50"
          >
            Edit Slack
          </button>
          <button
            type="button"
            disabled={!canConfigure || disconnecting}
            onClick={onDisconnect}
            className="rounded border border-critical-line px-2 py-1 text-xs font-medium text-critical hover:bg-critical-soft disabled:opacity-50"
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
        {disconnectError && (
          <p role="alert" className="text-xs text-critical">
            {disconnectError}
          </p>
        )}
      </section>
      <div className="min-w-0">
        {surface.hasBotToken ? (
          <ChannelManager getCredentials={getCredentials} canConfigure={canConfigure} />
        ) : (
          <p className="text-xs text-ink-muted">
            Add a bot token before choosing inbound channels.
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * The Inbound page: the channels the platform listens to, and the Slack connection behind them. Named
 * for what the operator is doing (choosing what comes IN) — "surface" is our internal domain term.
 */
export function InboundPanel(props: { embedded?: boolean; onChange?: () => void }) {
  return props.embedded ? <SlackConnectionSettings {...props} /> : <InboundOverview />;
}

function SlackConnectionSettings({
  embedded = false,
  onChange,
}: {
  embedded?: boolean;
  onChange?: () => void;
}) {
  const session = useSession();
  const { getCredentials } = session;
  const me = useMe(getCredentials, session.status === 'authenticated', session.sessionKey);
  const canConfigure =
    !me.data?.tenant?.impersonation &&
    (me.data?.tenant?.role === 'owner' || me.data?.tenant?.role === 'admin');
  const { surfaces, loading, error, refetch } = useSurfaces({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMode, setWizardMode] = useState<'connect' | 'edit'>('connect');
  const [wizardTrigger, setWizardTrigger] = useState<HTMLElement | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);

  const closeWizard = useCallback(() => {
    setWizardOpen(false);
    refetch();
    onChange?.();
  }, [refetch, onChange]);

  const disconnect = useCallback(() => {
    if (
      disconnecting ||
      !window.confirm('Disconnect Slack? Inbound channel subscriptions will be disabled.')
    ) {
      return;
    }
    setDisconnecting(true);
    setDisconnectError(null);
    void disconnectSlackSurface(config.apiBaseUrl, getCredentials)
      .then(() => {
        refetch();
        onChange?.();
      })
      .catch((disconnectFailure: unknown) =>
        setDisconnectError(
          disconnectFailure instanceof Error ? disconnectFailure.message : 'disconnect failed',
        ),
      )
      .finally(() => setDisconnecting(false));
  }, [disconnecting, getCredentials, refetch, onChange]);

  const connected = surfaces.length > 0;
  const initialLoading = loading && !connected;

  return (
    <section>
      <PageHeader
        headingLevel={embedded ? 2 : 1}
        title={embedded ? 'Chat access and subscriptions' : 'Inbound'}
        action={
          canConfigure && !connected && !loading ? (
            <button
              ref={connectButtonRef}
              type="button"
              onClick={(event) => {
                setWizardMode('connect');
                setWizardTrigger(event.currentTarget);
                setWizardOpen(true);
              }}
              className="rounded bg-strong px-3 py-1.5 text-sm font-medium text-on-strong hover:bg-strong-hover"
            >
              Connect Slack
            </button>
          ) : undefined
        }
      />

      {!canConfigure && (
        <p className="mb-4 text-sm text-ink-muted">
          Only workspace owners and admins can change Slack configuration and subscriptions.
        </p>
      )}
      {connected && (
        <p role="status" aria-live="polite" className="sr-only">
          {loading ? 'Refreshing inbound connection…' : ''}
        </p>
      )}

      {initialLoading && <StatePanel state="loading" title="Loading inbound…" skeleton="cards" />}
      {!loading && error && surfaces.length === 0 && (
        <StatePanel
          state="error"
          title="Failed to load the Slack connection."
          description="The Slack connection could not be retrieved."
          onRetry={refetch}
        />
      )}
      {error && surfaces.length > 0 && (
        <InlineAlert message="Failed to load the Slack connection." onRetry={refetch} />
      )}
      {!loading && !error && surfaces.length === 0 && (
        <StatePanel
          state="empty"
          title="Slack is not connected yet."
          description="Connect Slack to receive incidents from workspace channels."
        />
      )}
      {surfaces.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {surfaces.map((s) => (
            <SlackConfiguration
              key={s.id}
              surface={s}
              canConfigure={canConfigure}
              getCredentials={getCredentials}
              onEdit={(trigger) => {
                setWizardMode('edit');
                setWizardTrigger(trigger);
                setWizardOpen(true);
              }}
              onDisconnect={disconnect}
              disconnecting={disconnecting}
              disconnectError={disconnectError}
            />
          ))}
        </ul>
      )}

      {canConfigure && wizardOpen && (
        <SlackConnectWizard
          mode={wizardMode}
          onSave={(input) => saveSlackSurface(config.apiBaseUrl, getCredentials, input)}
          onRunTest={() => testSlackSurface(config.apiBaseUrl, getCredentials)}
          returnFocusTo={wizardTrigger ?? connectButtonRef.current}
          onClose={closeWizard}
        />
      )}
    </section>
  );
}
