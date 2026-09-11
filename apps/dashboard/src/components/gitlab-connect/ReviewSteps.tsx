import { SetupActions } from '../SetupDialogSlots';
import { GitLabEventGuide } from './EventGuide';
import type { GitLabWizardViewModel } from './view-model';

export function GitLabReviewSteps({ view }: { view: GitLabWizardViewModel }) {
  const {
    initialSettings,
    step,
    setStep,
    baseUrl,
    credential,
    discovery,
    eventTransport,
    hookScope,
    webhookSigningToken,
    busy,
    error,
    result,
    saveAndVerify,
    onClose,
  } = view;
  return (
    <>
      {step === 4 && discovery && (
        <div className="flex min-w-0 flex-col gap-4">
          <dl className="grid min-w-0 grid-cols-1 gap-3 rounded border border-line p-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-ink-muted">Instance</dt>
              <dd className="break-words">{new URL(baseUrl).host}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Group</dt>
              <dd className="break-words">{discovery.group.fullPath}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Projects</dt>
              <dd>{discovery.projects.length}, including subgroups</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Access</dt>
              <dd>Read-only API checks</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Credential</dt>
              <dd>{credential ? 'Replace stored token' : 'Keep stored token'}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Event sync</dt>
              <dd>
                {hookScope === 'projects' && view.managedProjects
                  ? `Managed project hooks · ${eventTransport === 'none' ? 'delivery not configured; management paused' : eventTransport === 'smee' ? 'Smee; authorization required after save' : 'Public HTTPS; authorization required after save'}`
                  : hookScope === 'system'
                    ? `System hook + polling · ${eventTransport === 'none' ? 'webhook not configured' : eventTransport === 'smee' ? 'Smee' : 'Public HTTPS'}`
                    : eventTransport === 'none'
                      ? 'Not configured'
                      : eventTransport === 'smee'
                        ? hookScope === 'projects'
                          ? `Smee · ${discovery.projects.length} project hooks`
                          : 'Smee group webhook'
                        : hookScope === 'projects'
                          ? `Direct · ${discovery.projects.length} project hooks`
                          : 'Direct group webhook'}
              </dd>
            </div>
            {eventTransport !== 'none' && (
              <div>
                <dt className="text-xs text-ink-muted">Webhook authentication</dt>
                <dd>
                  {webhookSigningToken || initialSettings?.webhookSigningTokenConfigured
                    ? 'HMAC-SHA256 payload signature'
                    : 'Legacy secret header'}
                </dd>
              </div>
            )}
          </dl>
          <p className="text-xs text-ink-muted">
            Verification must enumerate the group and read code, pipelines, and deployments from a
            sample project before the connector is enabled.
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
              {busy ? 'Verifying…' : 'Save and verify'}
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
              ? `Read access verified. Catalog: ${result.details?.projectCount ?? discovery?.projects.length ?? 0} projects; code, pipeline, and deployment checks use a sample project.`
              : 'GitLab saved but access verification failed.'}
          </p>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            <li>{result.authorized ? '✓' : '✕'} Token identity</li>
            <li>{result.checks?.canReadGroup ? '✓' : '✕'} Group read</li>
            <li>{result.checks?.canEnumerateProjects ? '✓' : '✕'} Subgroup project catalog</li>
            <li>{result.checks?.canReadCode ? '✓' : '✕'} Code history</li>
            <li>{result.checks?.canReadPipelines ? '✓' : '✕'} Pipeline history</li>
            <li>{result.checks?.canReadDeployments ? '✓' : '✕'} Deployment history</li>
            {eventTransport !== 'none' && (
              <li>
                {result.checks?.webhookSigningTokenConfigured ||
                result.checks?.webhookSecretConfigured
                  ? '✓'
                  : '✕'}{' '}
                Webhook credential saved
              </li>
            )}
          </ul>
          {result.warnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-warning">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          {result.status === 'healthy' && eventTransport === 'none' && (
            <p className="rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
              {hookScope === 'system'
                ? 'Read-only polling is enabled. No live webhook is configured; repository push events will not arrive until you install the system hook. Check project polling freshness on the connection details.'
                : 'Code access is ready. Event sync is not configured, so pushes, pipelines, and deployments will be fetched only during investigation and will not appear as synchronized change evidence.'}
            </p>
          )}
          {result.status === 'healthy' &&
            eventTransport !== 'none' &&
            !(hookScope === 'projects' && view.managedProjects) && <GitLabEventGuide view={view} />}
          <SetupActions>
            {
              <button
                type="button"
                onClick={() => setStep(1)}
                className="rounded border border-line-strong px-3 py-1.5 font-medium"
              >
                Edit configuration
              </button>
            }
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-strong px-3 py-1.5 font-medium text-on-strong"
            >
              {result.status === 'healthy' ? 'Finish' : 'Close'}
            </button>
          </SetupActions>
        </div>
      )}
    </>
  );
}
