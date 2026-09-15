import { IssueActionCard } from './IssueActionCard';
import { useEffect, useState } from 'react';
import type { IssueActionView, IssueChanges, RepositoryIssue } from '@sre/contracts';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import type { CredentialGetter } from '../lib/request-credentials';
import { checkResponse, requestErrorMessage } from '../lib/request-error';
import { SetupDialog } from './SetupDialog';

type Source = { id: string; name: string; type: 'github' | 'gitlab' };
const field = 'mt-1 w-full rounded border border-line-strong p-2';

export function IssueManagement({
  incidentId,
  apiBaseUrl,
  getCredentials,
}: {
  incidentId: string;
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ml-auto rounded border border-line-strong px-3 py-1.5 text-sm font-medium"
        onClick={() => setOpen(true)}
      >
        Issues
      </button>
      {open && (
        <IssueManagementDialog
          key={incidentId}
          incidentId={incidentId}
          apiBaseUrl={apiBaseUrl}
          getCredentials={getCredentials}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function IssueManagementDialog({
  incidentId,
  apiBaseUrl,
  getCredentials,
  onClose,
}: {
  incidentId: string;
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  onClose: () => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState('');
  const [repository, setRepository] = useState('');
  const [repositories, setRepositories] = useState<{ fullName: string }[]>([]);
  const [issues, setIssues] = useState<RepositoryIssue[]>([]);
  const [actions, setActions] = useState<IssueActionView[]>([]);
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [number, setNumber] = useState('');
  const [editing, setEditing] = useState<RepositoryIssue | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState('');
  const [assignees, setAssignees] = useState('');
  const [issueState, setIssueState] = useState<'open' | 'closed'>('open');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `${apiBaseUrl}/incidents/${incidentId}/issues`;

  async function request<T>(path: string, value?: unknown): Promise<T> {
    const response = await authenticatedFetch(
      `${base}/${path}`,
      getCredentials,
      value === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(value),
          },
    );
    await checkResponse(
      response,
      'Issue request failed. Refresh its status before repeating a change.',
    );
    return (await response.json()) as T;
  }
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(
        requestErrorMessage(
          cause,
          'Issue request failed. Refresh its status before repeating a change.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => setActions(await request<IssueActionView[]>('actions'));
  useEffect(() => {
    let active = true;
    void Promise.all([request<Source[]>('sources'), request<IssueActionView[]>('actions')])
      .then(([available, saved]) => {
        if (active) {
          setSources(available);
          setSource(available[0]?.id ?? '');
          setActions(saved);
        }
      })
      .catch((cause) => {
        if (active) setError(requestErrorMessage(cause, 'Issue connections could not be loaded.'));
      });
    return () => {
      active = false;
    };
  }, [base, getCredentials]);
  const changeTarget = () => {
    setEditing(null);
    setIssues([]);
    setRepositories([]);
  };
  const edit = (issue: RepositoryIssue | 'new') => {
    setEditing(issue);
    setTitle(issue === 'new' ? '' : issue.title);
    setBody(issue === 'new' ? '' : issue.body);
    setLabels(issue === 'new' ? '' : issue.labels.join(', '));
    setAssignees(issue === 'new' ? '' : issue.assignees.join(', '));
    setIssueState(issue === 'new' ? 'open' : issue.state);
    setRequestId(crypto.randomUUID());
  };
  const changed = () => setRequestId(crypto.randomUUID());
  const values: IssueChanges = {
    title: title.trim(),
    body,
    labels:
      editing && editing !== 'new' && labels === editing.labels.join(', ')
        ? editing.labels
        : labels
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
    assignees: assignees
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    ...(editing !== 'new' ? { state: issueState } : {}),
  };
  const changes = Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) =>
        !editing ||
        editing === 'new' ||
        JSON.stringify(value) !== JSON.stringify(editing[key as keyof RepositoryIssue]),
    ),
  ) as IssueChanges;
  const draft = async () => {
    if (!editing || Object.keys(changes).length === 0) return;
    await request('drafts', {
      requestId,
      draft: {
        connectorId: source,
        repository: repository.trim(),
        ...(editing !== 'new' ? { number: editing.number } : {}),
        changes,
      },
    });
    setEditing(null);
    await refresh();
  };
  return (
    <SetupDialog title="Repository issues" closeLabel="Close" busy={busy} onClose={onClose}>
      <p className="text-sm text-ink-muted">
        Read connected issues or prepare a change. Nothing is published until you confirm its saved
        preview.
      </p>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded border border-critical-line bg-critical-soft p-3 text-sm text-critical"
        >
          {error}
        </p>
      )}
      {!sources.length && (
        <p className="mt-3 text-sm">
          No GitHub or GitLab connection is available. Connect and verify one in Connections.
        </p>
      )}
      <fieldset disabled={busy} className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Connection
            <select
              className={field}
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setRepository('');
                changeTarget();
              }}
            >
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.type}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium">
            Repository
            <input
              className={field}
              list="issue-repositories"
              placeholder="team/service"
              value={repository}
              onChange={(event) => {
                setRepository(event.target.value);
                setEditing(null);
                setIssues([]);
              }}
            />
            <datalist id="issue-repositories">
              {repositories.map((item) => (
                <option key={item.fullName} value={item.fullName} />
              ))}
            </datalist>
          </label>
        </div>
        <button
          type="button"
          disabled={!source}
          className="rounded border border-line-strong px-3 py-1.5 text-sm"
          onClick={() =>
            void run(async () =>
              setRepositories(
                await request(
                  `repositories?${new URLSearchParams({ connectorId: source, query: repository })}`,
                ),
              ),
            )
          }
        >
          Find repositories
        </button>
        {repositories.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {repositories.map((item) => (
              <button
                key={item.fullName}
                type="button"
                className="rounded border border-line px-2 py-1 text-xs"
                onClick={() => {
                  setRepository(item.fullName);
                  changeTarget();
                }}
              >
                {item.fullName}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Issue state
            <select
              className={field}
              value={state}
              onChange={(event) => setState(event.target.value as 'open' | 'closed')}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </label>
          <label className="text-sm">
            Exact issue number (optional)
            <input
              className={field}
              inputMode="numeric"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!source || !repository.trim()}
            className="rounded border border-line-strong px-3 py-2 text-sm font-medium"
            onClick={() =>
              void run(async () => {
                const result = await request<RepositoryIssue[] | RepositoryIssue>(
                  `list?${new URLSearchParams({ connectorId: source, repository: repository.trim(), state, ...(number ? { number } : {}) })}`,
                );
                setIssues(Array.isArray(result) ? result : [result]);
              })
            }
          >
            Load issues
          </button>
          <button
            type="button"
            disabled={!source || !repository.trim()}
            className="rounded bg-strong px-3 py-2 text-sm font-medium text-on-strong"
            onClick={() => edit('new')}
          >
            New issue
          </button>
        </div>
        <p className="text-xs text-ink-muted">
          Lists show up to 50 recent issues. Enter an exact issue number for older items.
        </p>
        <ul className="divide-y divide-line">
          {issues.map((issue) => (
            <li key={issue.number} className="flex items-center justify-between gap-3 py-2 text-sm">
              <a
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 break-words text-link"
              >
                #{issue.number} {issue.title} · {issue.state}
              </a>
              <button
                type="button"
                className="shrink-0 rounded border border-line-strong px-2 py-1"
                onClick={() => edit(issue)}
              >
                Edit issue #{issue.number}
              </button>
            </li>
          ))}
        </ul>
        {editing && (
          <section className="space-y-3 rounded-lg border border-line p-4" aria-label="Issue draft">
            <h3 className="font-semibold">
              {editing === 'new' ? 'New issue' : `Edit issue #${editing.number}`}
            </h3>
            <label className="block text-sm font-medium">
              Title
              <input
                className={field}
                value={title}
                maxLength={255}
                onChange={(event) => {
                  setTitle(event.target.value);
                  changed();
                }}
              />
            </label>
            <label className="block text-sm font-medium">
              Description
              <textarea
                className={`${field} min-h-40`}
                value={body}
                maxLength={20_000}
                onChange={(event) => {
                  setBody(event.target.value);
                  changed();
                }}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Labels, comma separated
                <input
                  className={field}
                  value={labels}
                  onChange={(event) => {
                    setLabels(event.target.value);
                    changed();
                  }}
                />
              </label>
              <label className="text-sm">
                Assignees, comma separated
                <input
                  className={field}
                  value={assignees}
                  onChange={(event) => {
                    setAssignees(event.target.value);
                    changed();
                  }}
                />
              </label>
            </div>
            <p className="text-xs text-ink-muted">
              {sources.find((item) => item.id === source)?.type === 'gitlab'
                ? 'Use GitLab numeric user IDs for assignees.'
                : 'Use GitHub usernames for assignees.'}{' '}
              Empty labels or assignees clears that field when changed.
            </p>
            {editing !== 'new' && (
              <label className="block text-sm">
                New issue state
                <select
                  className={field}
                  value={issueState}
                  onChange={(event) => {
                    setIssueState(event.target.value as 'open' | 'closed');
                    changed();
                  }}
                >
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
            )}
            <button
              type="button"
              disabled={!title.trim() || Object.keys(changes).length === 0}
              onClick={() => void run(draft)}
              className="rounded bg-strong px-3 py-2 text-sm font-medium text-on-strong"
            >
              Review changes
            </button>
          </section>
        )}
      </fieldset>
      <section className="mt-5 space-y-3" aria-label="Saved issue changes">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Saved previews and outcomes</h3>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(refresh)}
            className="rounded border border-line-strong px-3 py-1.5 text-sm"
          >
            Refresh status
          </button>
        </div>
        {actions.length === 0 && (
          <p className="text-sm text-ink-muted">
            No issue changes have been requested for this incident.
          </p>
        )}
        {actions.map((action) => (
          <IssueActionCard
            key={action.id}
            action={action}
            busy={busy}
            onDecision={(id, decision) =>
              void run(async () => {
                await request(`actions/${id}`, { decision });
                await refresh();
              })
            }
          />
        ))}
      </section>
    </SetupDialog>
  );
}
