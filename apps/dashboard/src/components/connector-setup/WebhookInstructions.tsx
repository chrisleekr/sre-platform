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
  provider: 'GitHub' | 'GitLab' | 'Alertmanager';
}) {
  return (
    <section
      aria-label={`${provider} webhook setup`}
      className="min-w-0 space-y-2 rounded border border-line-strong bg-surface-subtle p-3 text-sm"
    >
      <h3 className="font-semibold">{provider} webhook URL</h3>
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
          {provider === 'Alertmanager' && (
            <p className="text-ink-muted">
              Keep the matching bearer token and send_resolved setting in the receiver. A URL alone
              is not the complete receiver configuration.
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
