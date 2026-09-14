import type { CredentialGetter } from '../lib/request-credentials';
import { config } from '../config';
import type { ConnectorSummary } from '../lib/connectors';
import { declareInvestigation, investigationSubjectKey } from '../lib/investigations';
import { InvestigationAction } from './InvestigationAction';
import { publicApiOrigin, publicWebhookUrl } from './connector-setup/event-delivery';
import { WebhookInstructions } from './connector-setup/WebhookInstructions';
import { GitLabPollingCoverage } from './gitlab-connect/PollingCoverage';
import {
  argoCdProjects,
  connectorState,
  disconnectLabel,
  disconnectMessage,
  evidenceTime,
  isManagedConnector,
  safeConnectorSummary,
  showsEventSync,
  textSetting,
} from './connectorPresentation';

export interface ConnectorBusyAction {
  connectorId: string;
  kind: 'test' | 'disconnect';
}

export function SavedConnectors({
  connectors,
  activeInvestigations,
  getCredentials,
  busyAction,
  confirmDisconnect,
  onManage,
  onRetest,
  onRequestDisconnect,
  onCancelDisconnect,
  onDisconnect,
}: {
  connectors: ConnectorSummary[];
  activeInvestigations: ReadonlyMap<string, string>;
  getCredentials: CredentialGetter;
  busyAction: ConnectorBusyAction | null;
  confirmDisconnect: string | null;
  onManage: (connector: ConnectorSummary, trigger: HTMLButtonElement) => void;
  onRetest: (connector: ConnectorSummary) => void;
  onRequestDisconnect: (connectorId: string) => void;
  onCancelDisconnect: () => void;
  onDisconnect: (connector: ConnectorSummary) => Promise<boolean>;
}) {
  if (connectors.length === 0) return null;
  return (
    <section aria-labelledby="saved-connectors-heading">
      <div className="mb-3">
        <h2 id="saved-connectors-heading" className="text-base font-semibold text-ink">
          Connection details
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Access checks and data delivery are independent. Review the latest evidence below.
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-3 text-sm">
        {connectors.map((c, index) => {
          if (c.capabilities?.availability === 'incomplete') return null;
          const state = connectorState(c);
          return (
            <li key={c.id}>
              <article
                aria-labelledby={`connector-${index}`}
                className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface p-4"
              >
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2 id={`connector-${index}`} className="break-words font-medium">
                      {c.name}
                    </h2>
                    <p className="text-xs text-ink-muted">
                      {c.type === 'argocd' ? 'Argo CD' : c.type}
                    </p>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${state.className}`}>
                    {state.label}
                  </span>
                </div>
                <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
                  {safeConnectorSummary(c.type, c.settings).map((value, summaryIndex) => (
                    <span key={`${summaryIndex}-${value}`} className="min-w-0 break-words">
                      {value}
                    </span>
                  ))}
                  {(c.type === 'github' || c.type === 'gitlab') &&
                    c.repositoryCount !== undefined && (
                      <span>
                        {c.repositoryCount} {c.type === 'github' ? 'repositories' : 'projects'}
                      </span>
                    )}
                </div>
                {c.type === 'argocd' && argoCdProjects(c.settings).length > 0 && (
                  <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Argo CD projects">
                    {argoCdProjects(c.settings).map((project) => {
                      const poll = c.polling?.projects?.find(
                        (candidate) => candidate.project === project.project,
                      );
                      return (
                        <li
                          key={project.project}
                          className={`rounded px-2 py-1 text-xs ${
                            !project.credentialConfigured || poll?.status === 'unhealthy'
                              ? 'bg-critical-soft text-critical'
                              : poll?.status === 'healthy'
                                ? 'bg-success-soft text-success'
                                : 'bg-surface-strong text-ink-secondary'
                          }`}
                        >
                          {project.project}
                          {!project.credentialConfigured
                            ? ' · token missing'
                            : poll?.status === 'unhealthy'
                              ? ` · ${poll.failureCategory?.replaceAll('_', ' ') ?? 'poll failed'}`
                              : poll?.status === 'healthy'
                                ? ' · polling'
                                : ' · not polled'}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {c.verification && (
                  <dl className="grid min-w-0 grid-cols-1 gap-5 border-t border-line pt-4 text-sm text-ink-muted md:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="font-medium text-ink-secondary">
                        {c.type === 'prometheus' ? 'Metrics access' : 'Verification'}
                      </dt>
                      <dd className="break-words">
                        Last attempt: {evidenceTime(c.verification.lastAttemptAt)}
                      </dd>
                      <dd className="break-words">
                        Last success: {evidenceTime(c.verification.lastSuccessAt)}
                      </dd>
                      {c.verification.failureCategory && (
                        <dd>Failure: {c.verification.failureCategory.replaceAll('_', ' ')}</dd>
                      )}
                      {c.verification.durationMs !== null &&
                        c.verification.durationMs !== undefined && (
                          <dd>Duration: {c.verification.durationMs} ms</dd>
                        )}
                      {c.verification.rateLimit?.remaining !== null &&
                        c.verification.rateLimit?.remaining !== undefined && (
                          <dd>
                            API remaining: {c.verification.rateLimit.remaining}
                            {c.verification.rateLimit.resetAt
                              ? `, resets ${evidenceTime(c.verification.rateLimit.resetAt)}`
                              : ''}
                          </dd>
                        )}
                    </div>
                    {showsEventSync(c) ? (
                      <div className="min-w-0">
                        <dt className="font-medium text-ink-secondary">
                          {c.type === 'prometheus' ? 'Alert lifecycle' : 'Event sync'}
                        </dt>
                        {textSetting(c.settings, 'eventTransport') === 'none' ? (
                          <>
                            <dd className="text-warning">Not configured</dd>
                            {c.type === 'prometheus' && (
                              <dd>Alerts can only arrive indirectly through subscribed chat.</dd>
                            )}
                          </>
                        ) : (
                          <>
                            {!c.events?.lastSuccessAt && (
                              <dd className="text-warning">
                                Awaiting first authenticated{' '}
                                {c.type === 'prometheus' ? 'Alertmanager event' : 'delivery'}
                              </dd>
                            )}
                            <dd className="break-words">
                              Last delivery: {evidenceTime(c.events?.lastAttemptAt)}
                            </dd>
                            <dd className="break-words">
                              Last verified: {evidenceTime(c.events?.lastSuccessAt)}
                            </dd>
                            <dd>
                              {c.events?.count ?? 0}{' '}
                              {c.type === 'github'
                                ? 'signed events synchronized'
                                : c.type === 'prometheus'
                                  ? 'authenticated alert events synchronized'
                                  : 'authenticated events synchronized'}
                            </dd>
                            {c.events?.failureCategory && (
                              <dd>Failure: {c.events.failureCategory.replaceAll('_', ' ')}</dd>
                            )}
                          </>
                        )}
                      </div>
                    ) : null}
                    {(c.capabilities?.polling === 'snapshots' || c.polling) &&
                    !(
                      c.type === 'gitlab' &&
                      c.settings.groupId != null &&
                      c.settings.eventStrategy !== 'system'
                    ) ? (
                      <div className="min-w-0">
                        <dt className="font-medium text-ink-secondary">Polling</dt>
                        <dd className="break-words">
                          Last attempt: {evidenceTime(c.polling?.lastAttemptAt)}
                        </dd>
                        <dd className="break-words">
                          Last success: {evidenceTime(c.polling?.lastSuccessAt)}
                        </dd>
                        <dd>
                          {c.polling?.snapshotCount ?? 0} snapshots, {c.polling?.errorCount ?? 0}{' '}
                          errors
                        </dd>
                        {c.polling?.failureCategory && (
                          <dd>Failure: {c.polling.failureCategory.replaceAll('_', ' ')}</dd>
                        )}
                        {c.polling?.durationMs !== null && c.polling?.durationMs !== undefined && (
                          <dd>Duration: {c.polling.durationMs} ms</dd>
                        )}
                        {c.polling?.gitlabCoverage && (
                          <dd>
                            <GitLabPollingCoverage coverage={c.polling.gitlabCoverage} />
                          </dd>
                        )}
                      </div>
                    ) : (
                      <div className="min-w-0">
                        <dt className="font-medium text-ink-secondary">Investigation access</dt>
                        <dd>On-demand, read-only tools</dd>
                        <dd>
                          {c.capabilities?.topology === 'inventory' ? (
                            <a href="/w/topology" className="text-info underline">
                              Scheduled topology discovery, review coverage
                            </a>
                          ) : (
                            'No background snapshot polling'
                          )}
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
                {textSetting(c.settings, 'eventTransport') === 'direct' &&
                  (c.type === 'github' || c.type === 'gitlab' || c.type === 'prometheus') &&
                  publicWebhookUrl(publicApiOrigin(config.apiBaseUrl), c.webhookPath ?? '') && (
                    <WebhookInstructions
                      provider={
                        c.type === 'github'
                          ? 'GitHub'
                          : c.type === 'gitlab'
                            ? 'GitLab'
                            : 'Alertmanager'
                      }
                      url={publicWebhookUrl(
                        publicApiOrigin(config.apiBaseUrl),
                        c.webhookPath ?? '',
                      )}
                    />
                  )}
                {isManagedConnector(c.type) && (
                  <div className="flex flex-wrap gap-2">
                    {state.label === 'Verification failed' ? (
                      <InvestigationAction
                        subject={{ kind: 'connector_verification', connectorId: c.id }}
                        activeIncidentId={activeInvestigations.get(
                          investigationSubjectKey({
                            kind: 'connector_verification',
                            connectorId: c.id,
                          }),
                        )}
                        preview={{
                          title: `${c.name} connector verification failed`,
                          source: `${c.type} · ${c.name}`,
                          condition:
                            c.verification?.failureCategory?.replaceAll('_', ' ') ??
                            'Verification failed',
                          severity: 'SEV3',
                        }}
                        declareInvestigation={(subject) =>
                          declareInvestigation(config.apiBaseUrl, getCredentials, subject)
                        }
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={(event) => onManage(c, event.currentTarget)}
                      className="rounded border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-subtle"
                    >
                      Manage
                    </button>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => onRetest(c)}
                      className="rounded border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-subtle disabled:opacity-50"
                    >
                      {busyAction?.connectorId === c.id && busyAction.kind === 'test'
                        ? 'Testing…'
                        : 'Retest'}
                    </button>
                    <details className="relative">
                      <summary className="cursor-pointer rounded border border-line-strong px-3 py-1.5 text-sm font-medium">
                        More actions
                      </summary>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => onRequestDisconnect(c.id)}
                        className="rounded border border-critical-line bg-surface px-3 py-1.5 text-sm font-medium text-critical hover:bg-critical-soft disabled:opacity-50"
                      >
                        Disconnect
                      </button>
                    </details>
                  </div>
                )}
                {isManagedConnector(c.type) && confirmDisconnect === c.id && (
                  <div
                    role="alertdialog"
                    aria-label={`Disconnect ${disconnectLabel(c)}`}
                    className="rounded border border-critical-line bg-critical-soft p-3 text-sm"
                  >
                    <p>{disconnectMessage(c.type)}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={onCancelDisconnect}
                        className="rounded border border-line-strong bg-surface px-3 py-1.5 font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => onDisconnect(c)}
                        className="rounded bg-critical-solid px-3 py-1.5 font-medium text-on-critical disabled:opacity-50"
                      >
                        {busyAction?.connectorId === c.id && busyAction.kind === 'disconnect'
                          ? 'Disconnecting…'
                          : 'Confirm disconnect'}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
