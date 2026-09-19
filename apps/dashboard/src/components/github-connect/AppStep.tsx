import { GitHubEventDelivery } from './EventDelivery';
import { GitHubCredentialRepair } from './CredentialRepair';
import { ConnectorSetupGuide } from '../connector-setup/ConnectorSetupGuide';
import { WebhookInstructions } from '../connector-setup/WebhookInstructions';
import { DataSourceNameField } from '../DataSourceNameField';
import type { GitHubWizardViewModel } from './view-model';

export function GitHubAppStep({ view }: { view: GitHubWizardViewModel }) {
  const {
    mode,
    step,
    dataSourceName,
    setDataSourceName,
    setupPath,
    setSetupPath,
    owner,
    setOwner,
    organization,
    setOrganization,
    deliveryMode,
    appId,
    setAppId,
    appSlug,
    privateKey,
    setPrivateKey,
    webhookSecret,
    setWebhookSecret,
    installUrl,
    relayStatus,
    busy,
    error,
    startManifest,
    discoverInstallations,
  } = view;
  return (
    <>
      {step === 1 && (
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="font-medium text-ink">
              {mode === 'edit'
                ? 'Manage GitHub access and event delivery'
                : 'Connect an installation, not a repository'}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              SRE Platform discovers every repository the installation can read, then resolves only
              the repositories relevant to an incident. Each data source needs its own dedicated
              GitHub App because an App registration has one webhook URL and secret.
            </p>
          </div>

          {mode === 'edit' && deliveryMode === 'direct' && (
            <WebhookInstructions provider="GitHub" url={view.eventEndpoint} />
          )}
          <ConnectorSetupGuide provider="github" />
          <DataSourceNameField
            value={dataSourceName}
            onChange={setDataSourceName}
            placeholder="Production GitHub"
          />
          <GitHubEventDelivery view={view} />
          {appId && (mode === 'edit' || installUrl) && <GitHubCredentialRepair view={view} />}

          {installUrl ? (
            <div className="rounded border border-success-line bg-success-soft p-3 text-sm text-success">
              <p className="font-medium">Dedicated App created and credentials stored.</p>
              {deliveryMode === 'smee' && (
                <p
                  className={`mt-3 text-xs ${
                    relayStatus === 'failed' ? 'text-critical' : 'text-success'
                  }`}
                >
                  {relayStatus === 'failed'
                    ? 'The App was stored, but the local event relay could not connect. Retry this setup.'
                    : 'The local event relay is managed by this connector. No separate command or restart is required.'}
                </p>
              )}
              <p className="mt-3 font-medium">
                1. Install it for the repositories responders may need.
              </p>
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                className="sre-action sre-action-primary mt-3"
              >
                Install dedicated App
              </a>
            </div>
          ) : appId && mode === 'edit' ? (
            <div className="flex flex-col gap-3 rounded border border-line bg-surface-subtle p-3 text-sm">
              <div>
                <p className="font-medium">GitHub App {appSlug || appId}</p>
                <p className="mt-1 text-ink-muted">
                  Continue to discover its current installation.
                </p>
              </div>
            </div>
          ) : (
            <>
              <fieldset className="rounded border border-line p-3">
                <legend className="px-1 text-sm font-medium">Setup path</legend>
                <label className="mt-1 flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="github-setup-path"
                    checked={setupPath === 'dedicated'}
                    onChange={() => setSetupPath('dedicated')}
                  />
                  <span>
                    <strong>New dedicated App</strong> (recommended). GitHub generates the key and
                    webhook secret; SRE Platform imports both automatically.
                  </span>
                </label>
                <label className="mt-3 flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="github-setup-path"
                    checked={setupPath === 'existing'}
                    onChange={() => setSetupPath('existing')}
                  />
                  <span>
                    <strong>Existing dedicated App.</strong> Use only when its webhook and
                    credentials are not shared with another product or SRE Platform data source.
                  </span>
                </label>
              </fieldset>

              {setupPath === 'dedicated' && (
                <>
                  <fieldset className="rounded border border-line p-3">
                    <legend className="px-1 text-sm font-medium">App owner</legend>
                    <div className="flex flex-wrap gap-4 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="github-owner"
                          checked={owner === 'personal'}
                          onChange={() => setOwner('personal')}
                        />
                        Personal account
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="github-owner"
                          checked={owner === 'organization'}
                          onChange={() => setOwner('organization')}
                        />
                        Organization
                      </label>
                    </div>
                    {owner === 'organization' && (
                      <label className="mt-3 block text-sm">
                        <span className="font-medium">Organization</span>
                        <input
                          value={organization}
                          onChange={(event) => setOrganization(event.target.value)}
                          placeholder="acme"
                          className="sre-field mt-1 min-w-0 w-full"
                        />
                      </label>
                    )}
                  </fieldset>
                </>
              )}

              {setupPath === 'existing' && (
                <div className="flex min-w-0 flex-col gap-3">
                  <label className="text-sm font-medium">
                    GitHub App ID or client ID
                    <input
                      value={appId}
                      onChange={(event) => setAppId(event.target.value)}
                      autoComplete="off"
                      className="sre-field mt-1 min-w-0 w-full"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    Private key (PEM)
                    <textarea
                      value={privateKey}
                      onChange={(event) => setPrivateKey(event.target.value)}
                      autoComplete="new-password"
                      rows={5}
                      className="sre-field mt-1 min-w-0 w-full resize-y font-instrument text-xs"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    Webhook secret
                    <input
                      type="password"
                      value={webhookSecret}
                      onChange={(event) => setWebhookSecret(event.target.value)}
                      autoComplete="new-password"
                      className="sre-field mt-1 min-w-0 w-full"
                    />
                  </label>
                  <p className="text-xs text-ink-muted">
                    Both secrets are encrypted at rest, write-only, and never shown again.
                  </p>
                </div>
              )}
            </>
          )}

          <div className="rounded border border-info-line bg-info-soft p-3 text-sm text-info">
            <p className="font-medium">Read-only permissions</p>
            <p className="mt-1">
              Contents is required for code and commit diagnosis. Pull requests, Actions, and
              Deployments add correlation evidence. Installation and repository membership events
              are delivered automatically by GitHub Apps.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            {installUrl || (appId && mode === 'edit') ? (
              <button
                type="button"
                disabled={busy}
                onClick={discoverInstallations}
                className="sre-action sre-action-primary self-start"
              >
                {busy
                  ? 'Checking…'
                  : installUrl
                    ? 'I installed it, discover installation'
                    : 'Check current installation'}
              </button>
            ) : setupPath === 'dedicated' ? (
              <button
                type="button"
                disabled={busy}
                onClick={startManifest}
                className="sre-action sre-action-primary self-start"
              >
                {busy ? 'Opening GitHub…' : 'Create dedicated GitHub App'}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={discoverInstallations}
                className="sre-action sre-action-primary self-start"
              >
                {busy ? 'Checking…' : 'Check existing App'}
              </button>
            )}
          </SetupActions>
        </div>
      )}
    </>
  );
}
import { SetupActions } from '../SetupDialogSlots';
