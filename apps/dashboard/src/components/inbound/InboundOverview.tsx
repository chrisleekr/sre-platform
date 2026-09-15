import { useMe } from '../../lib/me-store';
import { Link } from 'react-router-dom';
import { useSession } from '../../auth';
import { config } from '../../config';
import { useSurfaces } from '../../lib/useSurfaces';
import { formatAbsoluteTime } from '../../lib/time';
import { ChannelManager } from '../InboundChannelManager';
import { PageHeader } from '../PageHeader';
import { InlineAlert, StatePanel } from '../PageState';
import { slackEvidence } from '../connections/status';
import { inboundOutcomePresentation } from './outcome';

/** Intake controls are separate from the credentials that enable the connection. */
export function InboundOverview() {
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
  const slack = surfaces.find((s) => s.surface === 'slack');
  const latest = slack?.runtime?.inbound?.latest;
  const outcome = inboundOutcomePresentation(latest ?? null);
  const inbound = slack?.runtime?.inbound;
  const access = slack ? slackEvidence(slack).access : null;
  return (
    <section>
      <PageHeader
        title="Inbound"
        description="Choose where messages can enter investigations and see how they are handled."
        action={
          <Link
            to="/w/connectors?connection=slack"
            className="inline-flex min-h-10 items-center rounded-md border border-line-strong bg-surface px-3 py-2 text-sm font-medium"
          >
            {!canConfigure
              ? 'View Slack connection'
              : slack
                ? 'Manage Slack connection'
                : 'Connect Slack'}
          </Link>
        }
      />
      {!canConfigure && (
        <p className="mb-4 text-sm text-ink-muted">
          Only workspace owners and admins can change Slack configuration and subscriptions.
        </p>
      )}
      {error && (
        <InlineAlert
          message="Could not refresh inbound status. Previously loaded information may be outdated."
          onRetry={refetch}
        />
      )}
      {loading && !slack ? (
        <StatePanel state="loading" title="Loading inbound…" />
      ) : !slack && !error ? (
        <StatePanel
          state="empty"
          title="Connect a chat tool to get started."
          description="Connect Slack in Connections, then return here to choose the channels to listen to. No messages are received until setup and channel subscriptions are configured."
        />
      ) : null}
      {slack && (
        <>
          <section
            aria-label="Slack intake"
            className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-line pb-4"
          >
            <div>
              <h2 className="font-semibold">Slack</h2>
              <p
                className={
                  'mt-1 text-sm ' + (access?.attention ? 'text-warning' : 'text-ink-muted')
                }
              >
                {access?.label} · {access?.detail}
              </p>
            </div>
            <Link
              to="/w/signals"
              className="inline-flex min-h-10 items-center text-sm font-medium underline underline-offset-4"
            >
              View signals
            </Link>
          </section>
          <details
            aria-label="Message activity"
            className="mb-5 rounded-lg border border-line bg-surface p-4"
          >
            <summary className="cursor-pointer">
              <span className="font-semibold">Message activity</span>
              <span className="mt-2 block text-sm text-ink-secondary">
                {latest ? 'Latest event: ' + outcome.label : 'No inbound events recorded yet.'}
              </span>
              <span className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                {inbound ? (
                  <>
                    <span>{inbound.pendingCount} messages pending</span>
                    <span
                      className={inbound.failedLast24Hours ? 'text-critical' : 'text-ink-muted'}
                    >
                      {inbound.failedLast24Hours} failed or retrying in the last 24 hours
                    </span>
                  </>
                ) : (
                  <span className="text-ink-muted">Processing counts are not available yet.</span>
                )}
              </span>
            </summary>
            <p className="mt-3 border-t border-line pt-3 text-sm text-ink-muted">
              {latest
                ? outcome.detail
                : 'After subscribing, send a message or mention the bot in that channel.'}
            </p>
            {latest && (
              <time dateTime={latest.acceptedAt} className="mt-2 block text-xs text-ink-muted">
                {formatAbsoluteTime(latest.acceptedAt)}
              </time>
            )}
          </details>
          {slack.hasBotToken ? (
            <ChannelManager
              key={slack.id}
              getCredentials={getCredentials}
              canConfigure={canConfigure}
            />
          ) : (
            <StatePanel
              state="access"
              title="Channel subscriptions need Slack access."
              description="Open Manage Slack connection to finish setting up the bot token."
            />
          )}
        </>
      )}
      {slack && loading && (
        <p role="status" className="mt-3 text-sm text-ink-muted">
          Refreshing inbound status…
        </p>
      )}
    </section>
  );
}
