import { PublicDeliveryNotice, WebhookInstructions } from '../connector-setup/WebhookInstructions';
import { SetupCommand } from '../SetupCommand';
import type { GitHubWizardViewModel } from './view-model';

export function GitHubEventDelivery({ view }: { view: GitHubWizardViewModel }) {
  const {
    mode,
    initialSettings,
    deliveryMode,
    setDeliveryMode,
    deliveryUrl,
    setDeliveryUrl,
    eventEndpoint,
  } = view;
  return (
    <fieldset className="min-w-0 space-y-3 rounded border border-line p-3 text-sm">
      <legend className="px-1 font-medium">Receive events from GitHub</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-start gap-2 rounded border border-line p-3">
          <input
            type="radio"
            name="github-delivery"
            checked={deliveryMode === 'direct'}
            onChange={() => setDeliveryMode('direct')}
          />
          <span>
            <strong>Public HTTPS API</strong>
            <span className="block text-xs text-ink-muted">
              For a deployed platform reachable by GitHub.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 rounded border border-line p-3">
          <input
            type="radio"
            name="github-delivery"
            checked={deliveryMode === 'smee'}
            onChange={() => setDeliveryMode('smee')}
          />
          <span>
            <strong>Smee relay</strong>
            <span className="block text-xs text-ink-muted">For local development only.</span>
          </span>
        </label>
      </div>
      {deliveryMode === 'smee' ? (
        <>
          <label className="block font-medium" htmlFor="github-delivery-url">
            Smee channel URL
          </label>
          <input
            id="github-delivery-url"
            aria-describedby="github-delivery-help"
            type="url"
            value={deliveryUrl}
            onChange={(event) => setDeliveryUrl(event.target.value)}
            placeholder={
              mode === 'edit' && initialSettings?.smeeConfigured
                ? 'Leave blank to keep the encrypted channel'
                : 'https://smee.io/your-channel'
            }
            className="sre-field min-w-0 w-full"
          />
          <p id="github-delivery-help" className="text-xs text-ink-muted">
            A channel is generated automatically. You may also use an existing channel. The platform
            runs the relay after saving. Treat this URL as a secret; anyone with it can observe
            relayed requests.
          </p>
        </>
      ) : (
        <PublicDeliveryNotice available={Boolean(deliveryUrl)} />
      )}
      {deliveryMode === 'smee' && mode === 'edit' && initialSettings?.smeeConfigured && (
        <p className="text-xs text-ink-muted">
          A channel is configured. Leave blank to keep it; the encrypted channel is never prefilled.
        </p>
      )}
      {deliveryMode === 'direct' ? (
        mode === 'edit' ? (
          <p className="text-xs text-ink-muted">
            The full webhook URL and Copy button are at the top of this dialog.
          </p>
        ) : (
          <WebhookInstructions provider="GitHub" url={eventEndpoint} />
        )
      ) : (
        <>
          {deliveryUrl && (
            <SetupCommand command={deliveryUrl} copyLabel="Copy GitHub webhook URL" />
          )}
          <p className="text-xs text-ink-muted">
            For an existing App, use this Smee URL as its GitHub Webhook URL and use the same
            webhook secret. Stored channel URLs are never shown again.
          </p>
        </>
      )}
      <p className="text-xs text-ink-muted">
        Configure the provider with this address, then return here to save. New receivers do not
        accept events until saved; redeliver the provider’s test event afterwards. Closing an
        unsaved wizard discards this setup.
      </p>
    </fieldset>
  );
}
