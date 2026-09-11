import { SetupActions } from '../SetupDialogSlots';
import { EVENTS, permission } from './support';
import { WebhookInstructions } from '../connector-setup/WebhookInstructions';
import type { GitHubWizardViewModel } from './view-model';

export function GitHubRemainingSteps({ view }: { view: GitHubWizardViewModel }) {
  const {
    mode,
    step,
    setStep,
    setupPath,
    deliveryMode,
    appId,
    appSlug,
    relayStatus,
    installations,
    installationId,
    setInstallationId,
    busy,
    error,
    result,
    selectedInstallation,
    writePermissions,
    review,
    saveAndVerify,
    eventEndpoint,
    onClose,
  } = view;
  return (
    <>
      {step === 2 && (
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="font-semibold text-ink">Choose the installed account</h2>
            <p className="mt-1 text-sm text-ink-muted">
              One installation may expose hundreds of repositories; SRE Platform catalogs them
              automatically.
            </p>
          </div>
          <label className="font-medium">
            Installation
            <select
              value={installationId}
              onChange={(event) => setInstallationId(event.target.value)}
              className="mt-1 min-w-0 w-full rounded border border-line-strong px-2 py-1.5"
            >
              {installations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.accountLogin} ({item.accountType})
                </option>
              ))}
            </select>
          </label>
          <dl className="grid min-w-0 grid-cols-1 gap-2 rounded border border-line p-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="font-medium">Required: Contents</dt>
              <dd>{permission(selectedInstallation, 'contents')}</dd>
            </div>
            <div>
              <dt className="font-medium">Pull requests</dt>
              <dd>{permission(selectedInstallation, 'pull_requests')}</dd>
            </div>
            <div>
              <dt className="font-medium">Actions</dt>
              <dd>{permission(selectedInstallation, 'actions')}</dd>
            </div>
            <div>
              <dt className="font-medium">Deployments</dt>
              <dd>{permission(selectedInstallation, 'deployments')}</dd>
            </div>
          </dl>
          {writePermissions.length > 0 && (
            <p className="rounded border border-critical-line bg-critical-soft p-3 text-sm text-critical">
              Write access detected: {writePermissions.join(', ')}. SRE Platform requires a
              read-only GitHub App.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded border border-line-strong px-3 py-1.5 font-medium"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded bg-strong px-3 py-1.5 font-medium text-on-strong"
            >
              Review repository coverage
            </button>
          </SetupActions>
        </div>
      )}

      {step === 3 && selectedInstallation && (
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="font-semibold text-ink">Installation-wide repository coverage</h2>
            <p className="mt-1 text-sm text-ink-muted">
              No repository selection is required in SRE Platform. The catalog follows the
              installation's current GitHub grant.
            </p>
          </div>
          <dl className="rounded border border-line p-3 text-sm">
            <div>
              <dt className="font-medium">Account</dt>
              <dd>{selectedInstallation.accountLogin}</dd>
            </div>
            <div className="mt-2">
              <dt className="font-medium">GitHub grant</dt>
              <dd>
                {selectedInstallation.repositorySelection === 'all'
                  ? 'All repositories'
                  : 'Selected repositories managed in GitHub'}
              </dd>
            </div>
            <div className="mt-2">
              <dt className="font-medium">SRE Platform behavior</dt>
              <dd>
                Catalog every granted repository; inspect only incident-relevant repositories.
              </dd>
            </div>
          </dl>
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded border border-line-strong px-3 py-1.5 font-medium"
            >
              Back
            </button>
            <button
              type="button"
              onClick={review}
              className="rounded bg-strong px-3 py-1.5 font-medium text-on-strong"
            >
              Review connection
            </button>
          </SetupActions>
        </div>
      )}

      {step === 4 && selectedInstallation && (
        <div className="flex min-w-0 flex-col gap-4">
          <dl className="grid min-w-0 grid-cols-1 gap-3 rounded border border-line p-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-ink-muted">App</dt>
              <dd className="break-words">{appSlug || appId}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Installation</dt>
              <dd>{selectedInstallation.accountLogin}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Repositories</dt>
              <dd>
                {selectedInstallation.repositorySelection === 'all'
                  ? 'All granted repositories'
                  : 'Current GitHub selection'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Events</dt>
              <dd>{EVENTS.join(', ')}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Private key</dt>
              <dd>{view.privateKey.trim() ? 'Replace on save' : 'Keep saved key'}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Webhook secret</dt>
              <dd>
                {view.webhookSecret.trim()
                  ? 'Replace on save; update GitHub to match'
                  : 'Keep saved secret'}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-ink-muted">
            Verification mints a read-only installation token, enumerates the complete repository
            catalog, confirms Contents access, and saves the connection disabled until those checks
            pass.
          </p>
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              disabled={busy}
              onClick={() => setStep(3)}
              className="rounded border border-line-strong px-3 py-1.5 font-medium"
            >
              Back
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={saveAndVerify}
              className="rounded bg-strong px-3 py-1.5 font-medium text-on-strong disabled:opacity-50"
            >
              {busy ? 'Syncing and verifying…' : 'Save, sync, and verify'}
            </button>
          </SetupActions>
        </div>
      )}

      {step === 5 && result && (
        <div className="flex min-w-0 flex-col gap-4">
          <p
            role="status"
            className={
              result.status === 'healthy' ? 'font-medium text-success' : 'font-medium text-critical'
            }
          >
            {result.status === 'healthy'
              ? 'GitHub code access verified and repository catalog synchronized.'
              : 'GitHub saved but verification failed.'}
          </p>
          <ul className="space-y-1 text-sm">
            <li>{result.authorized ? '✓' : '✕'} Installation token minted</li>
            <li>
              {result.checks?.canEnumerateRepositories ? '✓' : '✕'} Repository catalog enumerated
            </li>
            <li>{result.checks?.canReadContents ? '✓' : '✕'} Contents and commit reads</li>
            <li>{result.checks?.readOnlyApp ? '✓' : '✕'} Read-only App grant</li>
            <li>
              {result.checks?.webhookSecretConfigured ? '✓' : '✕'} Webhook signature secret
              configured
            </li>
          </ul>
          <p className="text-sm font-medium">
            {result.details?.repositoryCount ?? 0} repositories synchronized
          </p>
          {result.warnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-warning">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          {deliveryMode === 'smee' && (
            <div
              className={`rounded border p-3 text-sm ${
                relayStatus === 'failed'
                  ? 'border-critical-line bg-critical-soft text-critical'
                  : 'border-success-line bg-success-soft text-success'
              }`}
            >
              {relayStatus === 'failed'
                ? 'Code access is saved, but the local Smee relay could not connect. Save again to retry it.'
                : relayStatus === 'connected'
                  ? 'Local Smee relay connected. This does not prove authenticated GitHub delivery.'
                  : 'Local Smee relay connection is not confirmed. Check the connection details before testing delivery.'}
            </div>
          )}
          {deliveryMode === 'direct' &&
            eventEndpoint &&
            (setupPath === 'existing' || mode === 'edit') && (
              <div className="rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
                <WebhookInstructions provider="GitHub" url={eventEndpoint} />
                <p className="mt-2">Subscribe to {EVENTS.join(', ')}, then redeliver a ping.</p>
              </div>
            )}
          <p className="text-xs text-ink-muted">
            Event health becomes verified after the first signed delivery. Installation and
            repository membership changes are synchronized automatically.
          </p>
          <SetupActions>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded border border-line-strong px-3 py-1.5 font-medium"
            >
              Edit configuration
            </button>
            <button
              type="button"
              onClick={onClose}
              className="self-start rounded bg-strong px-3 py-1.5 font-medium text-on-strong"
            >
              {result.status === 'healthy' ? 'Finish' : 'Close'}
            </button>
          </SetupActions>
        </div>
      )}
    </>
  );
}
