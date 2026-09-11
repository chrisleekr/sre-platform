import { SetupActions } from '../SetupDialogSlots';
import { GitLabEventGuide } from './EventGuide';
import { GitLabDeliveryStrategy } from './DeliveryStrategy';
import { DataSourceNameField } from '../DataSourceNameField';
import { ConnectorSetupGuide } from '../connector-setup/ConnectorSetupGuide';
import { PublicDeliveryNotice, WebhookInstructions } from '../connector-setup/WebhookInstructions';
import { SetupCommand } from '../SetupCommand';
import { randomWebhookSigningToken } from './support';
import type { GitLabWizardViewModel } from './view-model';

export function GitLabSetupSteps({ view }: { view: GitLabWizardViewModel }) {
  const {
    mode,
    initialSettings,
    step,
    setStep,
    dataSourceName,
    setDataSourceName,
    baseUrl,
    setBaseUrl,
    groupPath,
    setGroupPath,
    credential,
    setCredential,
    discovery,
    eventTransport,
    hookScope,
    deliveryUrl,
    setDeliveryUrl,
    webhookSigningToken,
    setWebhookSigningToken,
    busy,
    error,
    sampleProjects,
    legacy,
    canConfigureSignedWebhooks,
    eventSetupUnavailable,
    chooseEventTransport,
    discover,
    reviewEvents,
    eventEndpoint,
  } = view;
  return (
    <>
      {step === 1 && (
        <div className="flex min-w-0 flex-col gap-4">
          <ConnectorSetupGuide provider="gitlab" />
          {mode === 'edit' && eventTransport === 'direct' && (
            <WebhookInstructions provider="GitLab" url={eventEndpoint} />
          )}
          <div>
            <h2 className="font-semibold text-ink">Connect one operational group</h2>
            <p className="mt-1 text-sm text-ink-muted">
              SRE Platform catalogs every project in this group and its subgroups. You do not add
              projects one at a time.
            </p>
          </div>
          <DataSourceNameField
            value={dataSourceName}
            onChange={setDataSourceName}
            placeholder="Platform GitLab"
          />
          {legacy && (
            <p className="rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
              This is a legacy single-project connection. Complete this guide to migrate it to
              group-wide discovery.
            </p>
          )}
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="min-w-0 text-sm font-medium">
              GitLab URL
              <input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://gitlab.com"
                className="mt-1 min-w-0 w-full rounded border border-line-strong px-2 py-1.5"
              />
            </label>
            <label className="min-w-0 text-sm font-medium">
              Top-level group full path
              <input
                value={groupPath}
                onChange={(event) => setGroupPath(event.target.value)}
                placeholder="acme or acme/platform"
                className="mt-1 min-w-0 w-full rounded border border-line-strong px-2 py-1.5"
              />
            </label>
          </div>
          <div className="rounded border border-line bg-surface-subtle p-3 text-sm">
            <h3 className="font-semibold">Use read-only access in GitLab</h3>
            <p className="mt-2 text-ink-muted">
              Reuse a valid group-scoped read_api token with Reporter access. Create a token below
              only if you do not already have suitable access.
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-secondary">
              <li>Open the target group, then choose Settings → Access tokens.</li>
              <li>Create a group access token named “SRE Platform”.</li>
              <li>Select role Reporter, scope read_api, and an expiry date.</li>
              <li>Copy the token once and paste it below.</li>
            </ol>
            <p className="mt-2 text-xs text-ink-muted">
              On GitLab.com, group access tokens require Premium or Ultimate. If unavailable, use a
              dedicated group service account added only to this group as Reporter, then create its
              read_api token. Do not use a personal operator token for a permanent connector.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href="https://docs.gitlab.com/user/group/settings/group_access_tokens/"
                target="_blank"
                rel="noreferrer"
                className="rounded border border-line-strong bg-surface px-3 py-1.5 font-medium"
              >
                Group token guide
              </a>
              <a
                href="https://docs.gitlab.com/user/profile/service_accounts/"
                target="_blank"
                rel="noreferrer"
                className="rounded border border-line-strong bg-surface px-3 py-1.5 font-medium"
              >
                Service account fallback
              </a>
            </div>
          </div>
          <label className="min-w-0 text-sm font-medium">
            Read-only access token
            <input
              type="password"
              autoComplete="new-password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              className="mt-1 min-w-0 w-full rounded border border-line-strong px-2 py-1.5"
            />
            <span className="mt-1 block text-xs font-normal text-ink-muted">
              Encrypted at rest and never returned.
              {mode === 'edit' ? ' Leave blank to keep the stored token.' : ''}
            </span>
          </label>
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              disabled={busy}
              onClick={discover}
              className="self-start rounded bg-strong px-3 py-1.5 font-medium text-on-strong disabled:opacity-50"
            >
              {busy ? 'Checking group…' : 'Check access and discover projects'}
            </button>
          </SetupActions>
        </div>
      )}

      {step === 2 && discovery && (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="rounded border border-success-line bg-success-soft p-3 text-success">
            <p className="font-semibold">
              {discovery.projects.length} {discovery.projects.length === 1 ? 'project' : 'projects'}{' '}
              discovered
            </p>
            <p className="mt-1 text-sm">
              {discovery.group.fullPath} and all readable subgroups are covered by one connection.
            </p>
          </div>
          <div>
            <h2 className="font-semibold text-ink">Coverage sample</h2>
            <ul className="mt-2 max-h-52 space-y-1 overflow-auto rounded border border-line p-3 text-sm">
              {sampleProjects.map((project) => (
                <li key={project.id} className="flex min-w-0 justify-between gap-3">
                  <span className="min-w-0 break-words">{project.pathWithNamespace}</span>
                  {project.archived && <span className="shrink-0 text-warning">Archived</span>}
                </li>
              ))}
            </ul>
            {discovery.projects.length > sampleProjects.length && (
              <p className="mt-1 text-xs text-ink-muted">
                And {discovery.projects.length - sampleProjects.length} more. The full catalog is
                synchronized; this is not a selection step.
              </p>
            )}
          </div>
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
              Configure event sync
            </button>
          </SetupActions>
        </div>
      )}

      {step === 3 && (
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="font-semibold text-ink">Keep changes current</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Choose the GitLab event source, then how GitLab reaches this receiver. Read-only
              investigation access stays separate from permission to install hooks.
            </p>
          </div>
          <GitLabDeliveryStrategy view={view} />
          {eventSetupUnavailable && (
            <p className="rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
              Authenticated event sync requires GitLab 19.1 or newer. Code diagnosis can be saved
              now with Configure later.
            </p>
          )}
          <fieldset className="space-y-3 rounded border border-line p-3 text-sm">
            <legend className="px-1 font-medium">How can GitLab reach SRE Platform?</legend>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="gitlab-events"
                checked={eventTransport === 'smee'}
                disabled={eventSetupUnavailable}
                onChange={() => chooseEventTransport('smee')}
              />
              <span>
                <strong>Smee relay</strong>, for local development.
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="gitlab-events"
                checked={eventTransport === 'direct'}
                disabled={eventSetupUnavailable}
                onChange={() => chooseEventTransport('direct')}
              />
              <span>
                <strong>Public HTTPS API</strong>, for deployed environments.
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="gitlab-events"
                checked={eventTransport === 'none'}
                onChange={() => chooseEventTransport('none')}
              />
              <span>
                <strong>Configure later.</strong> No live webhooks.
                {hookScope === 'system'
                  ? ' Scheduled read-only polling starts after access verification.'
                  : ' Changes are fetched only during investigation.'}
              </span>
            </label>
          </fieldset>
          {eventTransport === 'smee' && (
            <p className="rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
              Smee can change JSON formatting and invalidate GitLab signatures. For reliable signed
              delivery, use Public HTTPS API with an endpoint that preserves the original request
              body. A connected relay does not prove authenticated delivery.
            </p>
          )}
          {eventTransport !== 'none' && (
            <>
              {eventTransport === 'smee' && (
                <label className="text-sm font-medium">
                  Smee channel URL
                  <span className="mt-1 block text-xs font-normal text-ink-muted">
                    Generated automatically. Use this address in GitLab, or enter an existing
                    channel. New receivers start after saving.
                  </span>
                  <input
                    aria-label="Smee channel URL"
                    value={deliveryUrl}
                    onChange={(event) => setDeliveryUrl(event.target.value)}
                    placeholder={
                      mode === 'edit' && initialSettings?.smeeConfigured
                        ? 'Leave blank to keep the encrypted channel'
                        : 'https://smee.io/your-channel'
                    }
                    className="mt-1 min-w-0 w-full rounded border border-line-strong px-2 py-1.5"
                  />
                  {eventTransport === 'smee' && initialSettings?.smeeConfigured && (
                    <span className="mt-1 block text-xs font-normal text-ink-muted">
                      A channel is configured and its relay is managed automatically.
                    </span>
                  )}
                </label>
              )}
              {eventTransport === 'smee' && deliveryUrl && (
                <SetupCommand command={deliveryUrl} copyLabel="Copy GitLab webhook URL" />
              )}
              {eventTransport === 'direct' && (
                <>
                  <PublicDeliveryNotice available={Boolean(deliveryUrl)} />
                  <WebhookInstructions provider="GitLab" url={eventEndpoint} />
                </>
              )}
              <div className="rounded border border-info-line bg-info-soft p-3 text-sm text-info">
                <p className="font-medium">Webhook authentication</p>
                {webhookSigningToken ? (
                  <>
                    <p className="mt-1 text-xs text-ink-muted">
                      A GitLab 19.1+ HMAC signing token has been generated. Save to store it
                      encrypted and activate payload verification. It is separate from your
                      read-only access token.
                    </p>
                  </>
                ) : initialSettings?.webhookSigningTokenConfigured ? (
                  <>
                    <p className="mt-1 text-xs text-ink-muted">
                      The existing write-only HMAC signing token remains active.
                    </p>
                    {canConfigureSignedWebhooks && (
                      <button
                        type="button"
                        onClick={() => setWebhookSigningToken(randomWebhookSigningToken())}
                        className="mt-2 rounded border border-line-strong bg-surface px-3 py-1.5 font-medium"
                      >
                        Replace signing token
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-xs text-ink-muted">
                      This connector still uses GitLab's legacy secret header. Upgrade it to payload
                      signing when the GitLab instance is 19.1 or newer.
                    </p>
                    {canConfigureSignedWebhooks && (
                      <button
                        type="button"
                        onClick={() => setWebhookSigningToken(randomWebhookSigningToken())}
                        className="mt-2 rounded border border-line-strong bg-surface px-3 py-1.5 font-medium"
                      >
                        Generate HMAC signing token
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          {eventTransport !== 'none' &&
            (hookScope === 'projects' && view.managedProjects ? (
              <p className="rounded border border-line p-3 text-sm">
                Save and verify read access first. Then review and authorize automatic project
                hooks. No hooks are changed before administrator approval.
              </p>
            ) : (
              <GitLabEventGuide view={view} />
            ))}
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
              onClick={reviewEvents}
              className="rounded bg-strong px-3 py-1.5 font-medium text-on-strong"
            >
              Review
            </button>
          </SetupActions>
        </div>
      )}
    </>
  );
}
