import { SetupCommand } from '../SetupCommand';
import { PUBLIC_API_CONFIGURATION_ERROR } from './event-delivery';

export function PublicDeliveryNotice({ available }: { available: boolean }) {
  return available ? (
    <p className="text-xs text-ink-muted">
      The webhook address is generated from the platform’s deployment configuration. No API URL
      needs to be entered here.
    </p>
  ) : (
    <p role="alert" className="text-sm text-warning">
      {PUBLIC_API_CONFIGURATION_ERROR}
    </p>
  );
}

export function WebhookInstructions({
  url,
  provider,
}: {
  url: string;
  provider: 'GitHub' | 'GitLab' | 'Alertmanager' | 'Datadog' | 'Grafana';
}) {
  return (
    <section
      aria-label={`${provider} webhook setup`}
      className="min-w-0 space-y-2 rounded border border-line-strong bg-surface-subtle p-3 text-sm"
    >
      <h3 className="font-medium">{provider} webhook URL</h3>
      {url ? (
        <>
          <p className="text-ink-secondary">
            Copy this full address into {provider}, not just the API origin. Opening this panel does
            not change the provider’s configuration.
          </p>
          <SetupCommand command={url} copyLabel={`Copy ${provider} webhook URL`} />
          {provider === 'GitHub' && (
            <p className="text-ink-muted">
              In the App’s settings, set Webhook URL, use the same webhook secret, keep SSL
              verification enabled, then redeliver a ping from Advanced → Recent Deliveries. Do not
              put this address in OAuth Callback URL.
            </p>
          )}
          {provider === 'GitLab' && (
            <p className="text-ink-muted">
              Keep the matching webhook authentication. Use the generated setup command when
              creating or replacing signed hooks, then send a Push event from the hook’s Test menu.
            </p>
          )}
          {(provider === 'Datadog' || provider === 'Grafana') && (
            <p className="text-ink-muted">
              Set Authorization: Bearer to the webhook bearer token saved in this connection.
              {provider === 'Datadog'
                ? ' Configure the Webhooks integration with the documented custom payload, including alert_id, alert_scope, alert_cycle_key, alert_transition and date. Add this webhook to the monitor notifications for trigger and recovery.'
                : ' Configure a webhook contact point with the default version 1 payload and resolved notifications enabled. Preserve each alert fingerprint, startsAt and endsAt; do not replace them with a text template.'}{' '}
              Enable Listen for the destination Slack channel. Send an isolated trigger and recovery
              to verify delivery.
            </p>
          )}
          {provider === 'Alertmanager' && (
            <p className="text-ink-muted">
              Keep the matching bearer token and send_resolved setting in the receiver. A URL alone
              is not the complete receiver configuration. Enable Listen for the destination channel
              and choose one intake owner per provider route. Drain or explicitly reconcile active
              episodes before switching between native delivery and direct Slack intake, including
              rollback. Validate an isolated route first; native Slack visibility depends on the
              platform, and an uncertain post is not automatically repaired.
            </p>
          )}
        </>
      ) : (
        <p className="text-ink-secondary">
          Preparing a stable webhook address. If preparation fails, use Retry above. Public delivery
          also requires a valid HTTPS API address in the deployment configuration.
        </p>
      )}
    </section>
  );
}
