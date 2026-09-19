import { useEffect, useState } from 'react';
import { requestErrorMessage } from '../../lib/request-error';
import type {
  GitLabManagementApi,
  GitLabManagementPreview,
  GitLabManagementStatus,
} from '../../lib/connector-api/gitlab-management';
import { evidenceTime } from '../connectorPresentation';

export function GitLabManagementPanel({
  api,
  connectorId,
  destination,
}: {
  api: GitLabManagementApi;
  connectorId: string;
  destination: string;
}) {
  const [status, setStatus] = useState<GitLabManagementStatus | null>(null);
  const [review, setReview] = useState<GitLabManagementPreview | null>(null);
  const [token, setToken] = useState('');
  const [approved, setApproved] = useState(false);
  const [recoveries, setRecoveries] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    setStatus(null);
    setReview(null);
    setApproved(false);
    setRecoveries([]);
    setToken('');
    void api
      .status(connectorId)
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch(() => {
        if (live) setError('Could not load webhook management. Refresh to retry.');
      });
    return () => {
      live = false;
    };
  }, [api, connectorId, destination]);
  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (failure) {
      setError(requestErrorMessage(failure, 'Webhook management failed.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 rounded-lg border border-line p-4"
      aria-label="Automatic project hook management"
    >
      <h3 className="font-medium">Automatic project hooks</h3>
      <p className="text-sm text-ink-muted">
        A workspace administrator must approve ongoing management for this saved connection.
        Investigation stays read-only. Existing manual hooks are not adopted or removed.
      </p>
      {status && (
        <>
          <p className="font-medium">
            {status.authorized
              ? 'Management authorized'
              : 'Management not authorized for the current configuration'}
          </p>
          <p className="text-sm">
            {status.counts.covered} covered · {status.counts.missing} confirmed missing ·{' '}
            {status.counts.pending} pending · {status.counts.failed} needing attention ·{' '}
            {status.counts.total} known projects
          </p>
          <p className="text-xs text-ink-muted">
            Counts overlap and reflect the last reconciliation. Catalog checked:{' '}
            {evidenceTime(status.catalogCheckedAt)}. A configured hook is not proof of event
            delivery. Future projects are discovered incrementally.
          </p>
          {status.failureCategory && (
            <p className="text-sm text-warning">
              Management check: {status.failureCategory.replaceAll('_', ' ')}. Check token access or
              review the scope again.
            </p>
          )}
          {!!status.projects.length && (
            <details>
              <summary className="cursor-pointer">Project status</summary>
              <ul className="mt-2 space-y-2 text-sm">
                {status.projects.map((project) => (
                  <li key={project.project} className="break-words">
                    {project.project}:{' '}
                    {project.failureCategory?.replaceAll('_', ' ') ??
                      (project.hookId ? 'Hook recorded' : 'Pending')}
                    {project.failureCategory === 'creation_uncertain' && (
                      <p className="text-xs text-warning">
                        GitLab did not confirm creation. The worker searches for its ownership
                        marker and will not create a duplicate. Ask an administrator to check this
                        project's webhook list. Then open Review management scope to explicitly
                        authorize one retry only if the hook is absent.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className="sre-action"
          onClick={() =>
            void run(async () => {
              setStatus(await api.status(connectorId));
            })
          }
        >
          Refresh coverage
        </button>
        <button
          type="button"
          disabled={busy}
          className="sre-action"
          onClick={() =>
            void run(async () => {
              setReview(await api.preview(connectorId, destination));
              setApproved(false);
              setRecoveries([]);
            })
          }
        >
          Review management scope
        </button>
        {status?.authorized && (
          <button
            type="button"
            disabled={busy}
            className="rounded border border-critical-line px-3 py-2 text-critical"
            onClick={() =>
              void run(async () => {
                await api.revoke(connectorId);
                setToken('');
                setReview(null);
                setApproved(false);
                setStatus(await api.status(connectorId));
                setNotice('Management stopped. Existing GitLab hooks were not removed.');
              })
            }
          >
            Stop management
          </button>
        )}
      </div>
      {review && (
        <div className="space-y-3 border-t border-line pt-3">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">GitLab instance</dt>
              <dd className="break-all">{review.scope.baseUrl}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Approved group and subgroups</dt>
              <dd className="break-words">{review.scope.groupPath}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-ink-muted">Receiver</dt>
              <dd className="break-all">{review.receiver}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-ink-muted">Events</dt>
              <dd>
                {Object.entries(review.scope.events)
                  .filter(([, enabled]) => enabled)
                  .map(([name]) => name.replaceAll('_', ' '))
                  .join(', ')}
              </dd>
            </div>
          </dl>
          <p className="text-sm">{review.effect}</p>
          <details>
            <summary className="cursor-pointer font-medium">
              Planned project actions ({review.projects.length} of {review.knownProjects} known
              projects)
            </summary>
            <p className="mt-2 text-xs text-ink-muted">
              Based on the last discovered catalog and recorded ownership, not a live GitLab diff.
              The worker rechecks membership and hook ownership before changes. Newly discovered
              projects in the approved group are included; unrelated hooks are never adopted.
            </p>
            <ul className="mt-2 space-y-2 text-sm">
              {review.projects.map((project) => (
                <li key={project.project} className="break-words">
                  <strong>{project.project}</strong>:{' '}
                  {project.action === 'recover'
                    ? 'Find the existing ownership marker; do not retry uncertain creation.'
                    : project.action === 'verify_or_update'
                      ? `Verify owned hook ${project.recordedHookId}; update only if its settings differ.`
                      : 'Inspect existing hooks; create only when no owned hook is found.'}
                  {project.recovery && (
                    <label className="mt-2 flex items-start gap-2 rounded border border-warning-line p-3">
                      <input
                        type="checkbox"
                        checked={recoveries.includes(project.recovery.recordId)}
                        onChange={(event) =>
                          setRecoveries((current) =>
                            event.target.checked
                              ? [...current, project.recovery!.recordId]
                              : current.filter((id) => id !== project.recovery!.recordId),
                          )
                        }
                      />
                      <span>
                        I checked GitLab and confirmed no hook exists with ownership ID{' '}
                        <code className="break-all">{project.recovery.ownershipId}</code> in its
                        description. Authorize one new creation attempt. Do not select this while
                        the earlier request may still be running.
                      </span>
                    </label>
                  )}
                </li>
              ))}
            </ul>
          </details>
          <label className="block text-sm font-medium">
            Management access token
            <input
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="sre-field mt-1 w-full bg-input"
            />
          </label>
          <p className="text-xs text-ink-muted">
            Use a separate GitLab group access token scoped to this group, with the api scope and
            Maintainer role. If group tokens are unavailable, use a dedicated account limited to
            these projects. This credential grants broader API privileges, not a hooks-only
            permission. It is encrypted, never shown again, and never passed to investigation tools.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={approved}
              onChange={(event) => setApproved(event.target.checked)}
            />
            I authorize ongoing creation and maintenance of SRE Platform's own hooks for this group
            and future projects, including push events from all branches.
          </label>
          <button
            type="button"
            disabled={busy || !approved || !token.trim()}
            className="sre-action sre-action-primary"
            onClick={() =>
              void run(async () => {
                await api.authorize(connectorId, {
                  destination,
                  reviewDigest: review.reviewDigest,
                  managementToken: token,
                  approved: true,
                  ...(recoveries.length
                    ? {
                        recoveries: review.projects.flatMap((project) =>
                          project.recovery && recoveries.includes(project.recovery.recordId)
                            ? [
                                {
                                  recordId: project.recovery.recordId,
                                  attemptedAt: project.recovery.attemptedAt,
                                  confirmedAbsent: true as const,
                                },
                              ]
                            : [],
                        ),
                      }
                    : {}),
                });
                setToken('');
                setReview(null);
                setApproved(false);
                setRecoveries([]);
                setStatus(await api.status(connectorId));
                setNotice(
                  'Management authorized. The worker will reconcile hooks; verify incoming events separately.',
                );
              })
            }
          >
            Authorize automatic hooks
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
