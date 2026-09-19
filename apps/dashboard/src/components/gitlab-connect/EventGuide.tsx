import { useState } from 'react';
import { SetupCommand } from '../SetupCommand';
import { EVENT_LABELS } from './support';
import type { GitLabWizardViewModel } from './view-model';
import { SystemHookFields, SystemHookTroubleshooting } from './SystemHookFields';

/** Instructions only. GitLab mutations remain an explicit operator action outside the platform. */
export function GitLabEventGuide({ view }: { view: GitLabWizardViewModel }) {
  const {
    step,
    discovery,
    hookScope,
    webhookInstallCommand,
    webhookSigningToken,
    eventTransport,
    relayStatus,
    providerWebhookUrl,
  } = view;
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  const projects =
    discovery?.projects.filter((project) =>
      project.pathWithNamespace.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const saved = step === 5;
  const system = hookScope === 'system';
  const events = system
    ? ['Push', 'Tag push', 'Merge request', 'Repository update', 'Project lifecycle']
    : hookScope === 'projects'
      ? EVENT_LABELS.filter((event) => !['Project', 'Subgroup'].includes(event))
      : EVENT_LABELS;
  return (
    <section
      aria-label="GitLab webhook setup"
      className="space-y-5 rounded-lg border border-line p-4"
    >
      <h3 className="font-medium">
        {saved ? 'Finish GitLab event delivery' : 'Set up webhooks in GitLab'}
      </h3>
      {eventTransport === 'smee' && (
        <p className="text-sm text-warning">
          Smee rebuilds JSON and can invalidate payload signatures even when the signing token is
          correct. If signed delivery fails through Smee, use a public HTTPS receiver that preserves
          the original body. A successful GitLab response from Smee is not receiver verification.
        </p>
      )}
      <ol className="space-y-5">
        <li className="space-y-2">
          <h4 className="font-medium">1. Save the receiver in SRE Platform</h4>
          <p className="text-sm text-ink-muted">
            {saved
              ? 'Read access verified. Saving this connection does not install GitLab webhooks.'
              : 'Choose Review, then Save and verify before running the installation command. The address and signing token are a draft until saved.'}
          </p>
          {saved && (
            <p className="text-sm text-ink-secondary">
              {eventTransport === 'smee'
                ? relayStatus === 'connected'
                  ? 'Receiver: Smee relay connected. No separate command or restart is required.'
                  : relayStatus === 'failed'
                    ? 'Receiver: Smee relay failed to connect. Retry setup before testing delivery.'
                    : 'Receiver: Smee relay connection is not confirmed. Check the connection details.'
                : 'Receiver: public endpoint configured. Reachability from GitLab is not yet proven.'}
            </p>
          )}
        </li>
        <li className="space-y-3">
          <h4 className="font-medium">
            2. Install{' '}
            {system
              ? 'the system hook'
              : hookScope === 'projects'
                ? 'project webhooks'
                : 'the group webhook'}
          </h4>
          <p className="text-sm font-medium">
            {system
              ? 'In GitLab: Admin → System hooks → Add new webhook.'
              : `In GitLab: ${hookScope === 'projects' ? 'Project' : 'Group'} → Settings → Webhooks → Add new webhook.`}
          </p>
          <p className="text-sm text-ink-muted">
            {system
              ? 'Install once per connection. GitLab sends instance-wide events; SRE Platform stores only supported project events within the configured group.'
              : hookScope === 'projects'
                ? `This covers ${discovery?.projects.length ?? 0} currently discovered projects. New projects need hooks too. Reopen this connection, check access to refresh the catalog, then rerun the command.`
                : 'A group webhook covers this group and its subgroups, including future projects.'}
          </p>
          {system && (
            <SystemHookFields
              baseUrl={view.baseUrl}
              receiver={providerWebhookUrl}
              name={view.webhookName}
            />
          )}
          <p className="text-sm text-ink-muted">
            Use glab and jq in your terminal. Sign in to the configured GitLab instance with{' '}
            {system
              ? 'instance administrator access'
              : hookScope === 'projects'
                ? 'Maintainer or Owner access to every covered project'
                : 'Owner access to the group'}
            . This is separate from the read-only token used for discovery.
          </p>
          <SetupCommand
            command={`glab auth status --hostname '${new URL(view.baseUrl).host}'`}
            copyLabel="Copy GitLab CLI access check"
          />
          {view.mode === 'edit' &&
            !view.initialSettings?.hookScope &&
            !view.initialSettings?.eventStrategy && (
              <p className="text-sm text-warning">
                This older connection did not record its hook scope. Confirm that Project hooks or
                Group hook matches your existing GitLab setup before installing anything.
              </p>
            )}
          <p className="text-sm text-ink-muted">
            Review the named hook before running this command. It creates or updates hooks with this
            connection's generated name and does not delete hooks. If it stops partway through,
            correct the reported error and rerun it. Your CLI credentials stay in your terminal, not
            in SRE Platform.
          </p>
          {webhookInstallCommand ? (
            <>
              {webhookSigningToken ? (
                <>
                  <button
                    type="button"
                    className="sre-action min-h-11"
                    onClick={() =>
                      void Promise.resolve()
                        .then(() => navigator.clipboard.writeText(webhookSigningToken))
                        .then(() => setCopied('Signing token copied.'))
                        .catch(() =>
                          setCopied('Copy failed. Allow clipboard access and try again.'),
                        )
                    }
                  >
                    Copy one-time signing token
                  </button>
                  <p role="status" className="text-xs text-ink-muted">
                    {copied}
                  </p>
                  <p className="text-xs text-ink-muted">
                    Store this signing token in your secret manager. The command prompts without
                    echoing it; the token is not embedded in the command or shell history.
                  </p>
                  {view.initialSettings?.webhookSigningTokenConfigured && (
                    <p className="text-sm text-warning">
                      Saving a replacement signing token interrupts existing hooks until all of them
                      use the new token.
                    </p>
                  )}
                </>
              ) : (
                <p className="rounded bg-warning-soft p-3 text-sm text-warning">
                  The saved signing token cannot be retrieved. Use your original token from your
                  secret manager when prompted. If it is lost, return to Events and replace the
                  signing token, save, then update every covered hook. Replacing it interrupts old
                  hooks until they are updated.
                </p>
              )}
              <details open={saved}>
                <summary className="cursor-pointer text-sm font-medium">
                  {saved
                    ? 'Install or update hooks'
                    : 'Preview installation command (run after saving)'}
                </summary>
                <div className="mt-3">
                  <SetupCommand
                    command={webhookInstallCommand}
                    copyLabel="Copy install-hook command"
                  />
                </div>
              </details>
            </>
          ) : (
            <p className="rounded bg-warning-soft p-3 text-sm text-warning">
              {!providerWebhookUrl
                ? 'The saved delivery address is not displayed here. Enter the existing channel on Events to generate instructions; do not replace working hooks with an unknown address.'
                : webhookSigningToken || view.initialSettings?.webhookSigningTokenConfigured
                  ? 'The installation preview will appear when webhook address preparation completes. Retry preparation if it fails.'
                  : 'An installation command requires payload signing. Keep existing legacy hooks unchanged, or generate a signing token on Events and save before installing hooks.'}
            </p>
          )}
          {!system && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Where are webhooks in GitLab?
              </summary>
              <div className="mt-3 space-y-3 text-sm">
                <p>
                  {system
                    ? 'Open Admin → System hooks → Add new webhook.'
                    : `Open ${hookScope === 'projects' ? 'each project' : 'the group'} → Settings → Webhooks → Add new webhook.`}{' '}
                  The command above configures these same settings, so you do not need to add them
                  manually as well.
                </p>
                <p>
                  Events: {events.join(', ')}. Keep SSL verification enabled. The webhook signing
                  token is not your read-only access token or the legacy Secret token field. Use the
                  generated command to install the matching signing token.
                </p>
                {hookScope === 'projects' ? (
                  <>
                    <label className="block">
                      Find project webhook settings
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        className="sre-field mt-1 w-full"
                        type="search"
                      />
                    </label>
                    <p className="text-xs text-ink-muted">
                      Showing {Math.min(projects.length, 8)} of {projects.length} matching projects.
                    </p>
                    <ul className="space-y-2">
                      {projects.slice(0, 8).map((project) => (
                        <li key={project.id}>
                          <a
                            className="break-words text-link underline"
                            target="_blank"
                            rel="noreferrer"
                            href={`${view.baseUrl.replace(/\/+$/, '')}/${project.pathWithNamespace.split('/').map(encodeURIComponent).join('/')}/-/hooks`}
                          >
                            {project.pathWithNamespace} → Webhooks
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : !system ? (
                  <a
                    className="text-link underline"
                    target="_blank"
                    rel="noreferrer"
                    href={`${view.baseUrl.replace(/\/+$/, '')}/groups/${discovery?.group.fullPath.split('/').map(encodeURIComponent).join('/')}/-/hooks`}
                  >
                    Open group webhook settings
                  </a>
                ) : null}
                <a
                  className="block text-link underline"
                  href={
                    system
                      ? 'https://docs.gitlab.com/administration/system_hooks/'
                      : 'https://docs.gitlab.com/user/project/integrations/webhooks/'
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  GitLab webhook guide
                </a>
              </div>
            </details>
          )}
        </li>
        <li className="space-y-2">
          <h4 className="font-medium">3. Prove event delivery</h4>
          <p className="text-sm text-ink-muted">
            {system
              ? "Check a real push or project event from the configured group in the hook's Recent events. GitLab's generic mock system-hook test may be ignored because it lacks an in-scope project path."
              : "In GitLab, open the hook's Test menu and send a Push event. Check its response and Recent events."}{' '}
            Then close this modal and check the connection's authenticated delivery evidence.
          </p>
          <p className="text-sm font-medium">
            Delivery is not verified by this access check. One successful event proves that hook's
            path, not that every project has a hook.
          </p>
          {system && (
            <>
              <p className="text-sm text-ink-muted">
                Open this hook in Admin → System hooks and inspect Recent events. Use a normal,
                approved push or merge-request update from{' '}
                <strong>{discovery?.group.fullPath}</strong> or one of its subgroups; do not delete
                a project or create a production change just to test a hook. Check the receiver's
                HTTP response, then refresh SRE Platform's first/last authenticated delivery and
                event count. Retest read access does not send a webhook.
              </p>
              <SystemHookTroubleshooting />
            </>
          )}
        </li>
      </ol>
      {system && (
        <section
          className="rounded border border-info-line bg-info-soft p-3 text-sm"
          aria-label="System-hook coverage"
        >
          <h4 className="font-semibold">Webhooks and polling prove different things</h4>
          <p className="mt-2">
            System hooks supply repository and project events, not CI/CD status. Scheduled read-only
            polling supplies pipeline, child-pipeline, job, deployment, and release observations. It
            starts after access verification, with no instance-administrator token stored here.
          </p>
          <p className="mt-2">
            Polling is bounded and may be delayed by backlog, permissions, or rate limits. Pipeline
            and deployment backfill starts with the last 24 hours. Intermediate transitions can be
            missed; polling is not a complete event history. Check per-project freshness separately
            from webhook delivery.
          </p>
        </section>
      )}
    </section>
  );
}
