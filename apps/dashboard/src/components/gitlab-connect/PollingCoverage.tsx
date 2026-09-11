import type { ConnectorSummary } from '../../lib/connectors';
import { evidenceTime } from '../connectorPresentation';

export function GitLabPollingCoverage({
  coverage,
}: {
  coverage: NonNullable<NonNullable<ConnectorSummary['polling']>['gitlabCoverage']>;
}) {
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3 text-sm">
      <p className="font-semibold">Project polling coverage</p>
      <p>
        {coverage.total} projects · {coverage.notChecked} not yet checked · {coverage.failed}{' '}
        failing · {coverage.backlog} with backlog
      </p>
      <p>Oldest successful project read: {evidenceTime(coverage.oldestReadAt)}</p>
      {!!coverage.trackingLimited && (
        <p className="rounded border border-warning-line bg-warning-soft p-2 text-warning">
          Active-work tracking limit reached in {coverage.trackingLimited} project(s). Polling
          continues, but some active work may no longer be tracked individually. Each stream keeps
          at most 100 active IDs. A later successful read does not clear this coverage warning.
        </p>
      )}
      <p className="text-xs text-ink-muted">
        Counts overlap. A successful read does not prove webhook delivery or a complete event
        history. Backlogs and rate limits delay updates.
      </p>
      <details>
        <summary className="cursor-pointer font-medium">
          Project details ({coverage.projects.length} of {coverage.total}, failures and oldest reads
          first)
        </summary>
        <ul className="mt-2 space-y-3">
          {coverage.projects.map((project) => (
            <li key={project.project} className="min-w-0 rounded border border-line p-2">
              <p className="break-words font-medium">{project.project}</p>
              <p>Last successful read: {evidenceTime(project.lastSuccessAt)}</p>
              <p>
                {project.failureCategory
                  ? `Read failed: ${project.failureCategory.replaceAll('_', ' ')}`
                  : project.lastSuccessAt
                    ? 'Last read succeeded'
                    : 'Awaiting first successful read'}
                {project.backlog ? ' · More pages pending' : ''}
                {project.trackingLimited ? ' · Active-work tracking limit reached' : ''}
              </p>
              {project.failureCategory && (
                <p className="text-xs text-ink-muted">
                  {project.failureCategory === 'timestamp_boundary_limit'
                    ? 'Too many updates share a timestamp boundary to advance safely. Coverage is incomplete; the cursor is retained and other streams continue. Use group or project hooks for ongoing CI/CD delivery if this limit persists. Changing credentials will not fix this limit.'
                    : "Check this project's access and the connection credential. Polling retries automatically; edit the connection if credentials or scope changed."}
                </p>
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
