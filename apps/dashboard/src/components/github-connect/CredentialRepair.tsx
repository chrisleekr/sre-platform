import type { GitHubWizardViewModel } from './view-model';

/** Credential replacements are explicit, write-only, and independent from one another. */
export function GitHubCredentialRepair({ view }: { view: GitHubWizardViewModel }) {
  return (
    <section
      aria-label="Repair GitHub connection"
      className="space-y-4 rounded-lg border border-line p-4"
    >
      <div>
        <h3 className="font-medium">Repair this connection</h3>
        <p className="mt-1 text-sm text-ink-muted">
          App {view.appSlug || view.appId}. Leave replacement fields blank to keep the saved
          credentials. Changes take effect only after Save, sync, and verify.
        </p>
      </div>
      {view.eventFailureCategory && (
        <p
          role="status"
          className="rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning"
        >
          {view.eventFailureCategory === 'signature_mismatch'
            ? 'Last delivery failed signature validation. Check the webhook URL and matching secret below.'
            : 'The last event delivery failed. Review the URL, webhook secret, and GitHub delivery response below.'}{' '}
          Rechecking the installation does not verify webhook delivery.
        </p>
      )}
      <details open={Boolean(view.eventFailureCategory)}>
        <summary className="cursor-pointer font-medium">Repair webhook delivery</summary>
        <div className="mt-3 space-y-3 text-sm">
          <p>
            A signature mismatch concerns the webhook secret or delivered payload, not the App
            private key. First check that GitHub's Webhook URL points to this connection's public
            endpoint or Smee channel.
          </p>
          <ol className="list-decimal space-y-2 pl-5 text-ink-muted">
            <li>
              Open the GitHub App's settings. For a personal App, use Settings → Developer settings
              → GitHub Apps → Edit. For an organization-owned App, start in that organization's
              settings.
            </li>
            <li>
              Set the same webhook secret in GitHub and in the field below. Do not use the App
              client secret or private key here.
            </li>
            <li>
              Continue through this wizard and Save, sync, and verify. Replacing the secret
              temporarily interrupts delivery until both sides match.
            </li>
            <li>
              In the App's Advanced tab, redeliver an event. Check its response and the connection's
              event-delivery status. Access verification alone does not prove delivery.
            </li>
          </ol>
          <label className="block font-medium">
            Replacement webhook secret
            <input
              type="password"
              autoComplete="new-password"
              value={view.webhookSecret}
              onChange={(event) => view.setWebhookSecret(event.target.value)}
              className="sre-field mt-1 w-full"
            />
          </label>
          <p className="text-xs text-ink-muted">
            At least 16 characters when replacing. Stored encrypted and never shown again. Blank
            keeps the saved secret.
          </p>
          {view.webhookSecret && (
            <button
              type="button"
              onClick={() => view.setWebhookSecret('')}
              className="sre-action min-h-11"
            >
              Keep saved webhook secret
            </button>
          )}
        </div>
      </details>
      <details>
        <summary className="cursor-pointer font-medium">Replace private key for API access</summary>
        <div className="mt-3 space-y-3 text-sm">
          <p>
            Use this when GitHub rejects App authentication, for example after a key was revoked. A
            webhook signature failure alone does not require a new private key.
          </p>
          <p className="text-ink-muted">
            In this same GitHub App's General settings, find Private keys and generate a key. Paste
            the downloaded PEM below, then check the current installation. Keep the old key until
            the replacement is saved and verified.
          </p>
          <label className="block font-medium">
            Replacement private key (PEM)
            <textarea
              autoComplete="new-password"
              rows={5}
              value={view.privateKey}
              onChange={(event) => view.setPrivateKey(event.target.value)}
              className="sre-field mt-1 w-full resize-y font-instrument text-xs"
            />
          </label>
          <p className="text-xs text-ink-muted">
            Blank keeps the saved private key. The key must belong to App ID {view.appId}; this does
            not switch the connection to another App.
          </p>
          {view.privateKey && (
            <button
              type="button"
              onClick={() => view.setPrivateKey('')}
              className="sre-action min-h-11"
            >
              Keep saved private key
            </button>
          )}
        </div>
      </details>
      <div className="flex flex-wrap gap-3 text-sm">
        <a
          href="https://github.com/settings/apps"
          target="_blank"
          rel="noreferrer"
          className="text-link underline"
        >
          Personal GitHub App settings
        </a>
        <a
          href="https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#troubleshooting"
          target="_blank"
          rel="noreferrer"
          className="text-link underline"
        >
          Troubleshoot webhook signatures
        </a>
      </div>
    </section>
  );
}
