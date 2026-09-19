import { checkResponse, requestErrorMessage } from '../lib/request-error';
import type { CredentialGetter } from '../lib/request-credentials';
import { useState } from 'react';
import { config } from '../config';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { IncidentTag } from './IncidentTag';

interface TagBody {
  tags: Array<{ id: string; tag: string }>;
  suggestions: Array<{ id: string; tag: string }>;
  linkRules: Array<{ prefix: string; urlTemplate: string }>;
  historySuggestions: Array<{ tag: string; appliedCount: number }>;
}

/** Human-applied tags and evidence-backed cause suggestions for one Incident. */
export function IncidentTags(props: {
  incidentId: string;
  getCredentials: CredentialGetter;
  data: TagBody;
  refresh: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = async (path: string, method: 'POST' | 'DELETE', tag?: string) => {
    setPending(true);
    setError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}${path}`,
        props.getCredentials,
        {
          method,
          headers: tag ? { 'content-type': 'application/json' } : undefined,
          body: tag ? JSON.stringify({ tag }) : undefined,
        },
      );
      await checkResponse(response, 'Tag change failed. Retry when the service is available.');
      setDraft('');
      setSuggestionId(null);
      props.refresh();
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Tag change failed.'));
    } finally {
      setPending(false);
    }
  };
  return (
    <section aria-label="Incident tags" className="mt-3 min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {props.data.tags.length > 0 && <span className="text-xs text-ink-muted">Tags</span>}
        {props.data.tags.map((row) => (
          <span
            key={row.id}
            className="inline-flex max-w-full items-center gap-1 break-all rounded-full bg-surface-subtle px-2 py-1 text-xs"
          >
            <IncidentTag tag={row.tag} linkRules={props.data.linkRules} />
            {editing && (
              <button
                type="button"
                aria-label={`Remove ${row.tag}`}
                disabled={pending}
                onClick={() => mutate(`/incidents/${props.incidentId}/tags/${row.id}`, 'DELETE')}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          aria-expanded={editing}
          aria-controls="incident-tag-editor"
          onClick={() => setEditing(!editing)}
          className="min-h-9 rounded px-2 text-xs font-medium text-ink-secondary underline decoration-line-strong underline-offset-4 hover:bg-surface-subtle"
        >
          {editing ? 'Done editing tags' : props.data.tags.length > 0 ? 'Edit tags' : 'Add tag'}
        </button>
      </div>
      {editing && (
        <div id="incident-tag-editor" className="mt-2 rounded-lg border border-line bg-surface p-3">
          {props.data.suggestions.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase text-ink-muted">
                Evidence-backed suggestions
              </p>
              {props.data.suggestions.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  disabled={pending}
                  className="sre-action mr-2 mt-2"
                  onClick={() => {
                    setDraft(row.tag);
                    setSuggestionId(row.id);
                  }}
                >
                  Review {row.tag}
                </button>
              ))}
            </div>
          )}
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const tag = draft.trim();
              if (!tag) return;
              const path = suggestionId
                ? `/incidents/${props.incidentId}/tag-suggestions/${suggestionId}/accept`
                : `/incidents/${props.incidentId}/tags`;
              mutate(path, 'POST', tag);
            }}
          >
            <label className="sr-only" htmlFor="incident-tag-input">
              Add tag
            </label>
            <input
              id="incident-tag-input"
              list="incident-tag-history"
              value={draft}
              disabled={pending}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="cause:deployment"
              className="sre-field min-w-0 flex-1 bg-canvas"
            />
            <datalist id="incident-tag-history">
              {props.data.historySuggestions.map((row) => (
                <option key={row.tag} value={row.tag}>
                  {row.appliedCount} previous uses
                </option>
              ))}
            </datalist>
            <button type="submit" disabled={pending} className="sre-action">
              {suggestionId ? 'Apply suggestion' : 'Save tag'}
            </button>
          </form>
          <p role="status" aria-live="polite" className="mt-2 text-sm text-critical">
            {error ?? (pending ? 'Saving tag…' : '')}
          </p>
        </div>
      )}
    </section>
  );
}
