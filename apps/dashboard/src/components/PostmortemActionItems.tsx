import { checkResponse, requestErrorMessage } from '../lib/request-error';
import {
  ACTION_ITEM_STATES,
  ACTION_ITEM_TYPES,
  type ActionItemState,
  type ActionItemType,
  type PostmortemActionItem,
} from '@sre/contracts';
import { useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { authenticatedFetch } from '../lib/authenticatedFetch';

const INPUT = 'min-h-9 w-full rounded border border-line-strong bg-surface px-2 py-1 text-sm';
const BUTTON =
  'sre-hit-target rounded border border-line-strong bg-surface px-3 py-1 text-sm font-medium text-ink-secondary hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-60';

type ItemDraft = { title: string; owner: string; trackerUrl: string; dueAt: string };
type NewItemDraft = { type: ActionItemType } & ItemDraft;

const EMPTY_DRAFT: NewItemDraft = {
  type: 'prevent',
  title: '',
  owner: '',
  trackerUrl: '',
  dueAt: '',
};

const draftOf = (item: PostmortemActionItem): ItemDraft => ({
  title: item.title,
  owner: item.owner ?? '',
  trackerUrl: item.trackerUrl ?? '',
  dueAt: item.dueAt ? item.dueAt.slice(0, 10) : '',
});

/** An open item with no owner or no tracker link is untracked, a defect the table never hides. */
export const isUntracked = (item: Pick<PostmortemActionItem, 'owner' | 'trackerUrl'>): boolean =>
  !item.owner || !item.trackerUrl;

/**
 * Action items of one postmortem: inline edit of title, owner, tracker link, state and due date,
 * plus a form to add a human-authored item. Every change is its own request, so a failure never
 * loses another row's edit.
 */
export function PostmortemActionItems({
  incidentId,
  items,
  onChanged,
}: {
  incidentId: string;
  items: PostmortemActionItem[];
  onChanged: (item: PostmortemActionItem) => void;
}) {
  const { getCredentials } = useSession();
  const base = `${config.apiBaseUrl}/incidents/${encodeURIComponent(incidentId)}/postmortem/action-items`;
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NewItemDraft>(EMPTY_DRAFT);

  async function send(url: string, method: 'POST' | 'PATCH', body: unknown, id: string) {
    if (pendingId) return false;
    setPendingId(id);
    setError(null);
    try {
      const response = await authenticatedFetch(url, getCredentials, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await checkResponse(
        response,
        response.status === 400
          ? 'Action item rejected: the tracker link must be an https URL and the title non-empty.'
          : 'Action item could not be saved.',
      );
      onChanged(((await response.json()) as { actionItem: PostmortemActionItem }).actionItem);
      return true;
    } catch (err) {
      setError(requestErrorMessage(err, 'Action item could not be saved.'));
      return false;
    } finally {
      setPendingId(null);
    }
  }

  const patch = (item: PostmortemActionItem, body: Record<string, unknown>) =>
    send(`${base}/${encodeURIComponent(item.id)}`, 'PATCH', body, item.id);

  return (
    <section aria-label="Action items" className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight">Action items</h2>
      <p className="text-sm text-ink-muted">
        Each item needs an owner and a tracker link; an untracked item is a defect, not a plan.
      </p>
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
              <th className="py-1 pr-2">Type</th>
              <th className="py-1 pr-2">Title</th>
              <th className="py-1 pr-2">Owner</th>
              <th className="py-1 pr-2">Tracker</th>
              <th className="py-1 pr-2">State</th>
              <th className="py-1 pr-2">Due</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="py-2 text-ink-muted">
                  No action items yet.
                </td>
              </tr>
            )}
            {items.map((item) => (
              <ActionItemRow
                key={`${item.id}:${item.updatedAt}`}
                item={item}
                pending={pendingId === item.id}
                onPatch={(body) => void patch(item, body)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <form
        aria-label="Add action item"
        className="grid gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          void send(
            base,
            'POST',
            {
              type: draft.type,
              title: draft.title,
              owner: draft.owner || undefined,
              trackerUrl: draft.trackerUrl || undefined,
              dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : undefined,
            },
            'new',
          ).then((ok) => {
            if (ok) setDraft(EMPTY_DRAFT);
          });
        }}
      >
        <label className="text-xs text-ink-muted">
          Type
          <select
            value={draft.type}
            onChange={(event) => setDraft({ ...draft, type: event.target.value as ActionItemType })}
            className={INPUT}
          >
            {ACTION_ITEM_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted sm:col-span-2">
          Title
          <input
            required
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            className={INPUT}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Owner
          <input
            value={draft.owner}
            onChange={(event) => setDraft({ ...draft, owner: event.target.value })}
            className={INPUT}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Tracker link
          <input
            type="url"
            value={draft.trackerUrl}
            onChange={(event) => setDraft({ ...draft, trackerUrl: event.target.value })}
            className={INPUT}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Due
          <input
            type="date"
            value={draft.dueAt}
            onChange={(event) => setDraft({ ...draft, dueAt: event.target.value })}
            className={INPUT}
          />
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={pendingId !== null || !draft.title.trim()}
            className={BUTTON}
          >
            Add action item
          </button>
        </div>
      </form>
    </section>
  );
}

function ActionItemRow({
  item,
  pending,
  onPatch,
}: {
  item: PostmortemActionItem;
  pending: boolean;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const saved = draftOf(item);
  const [edit, setEdit] = useState<ItemDraft>(saved);
  const dirty = (Object.keys(saved) as (keyof ItemDraft)[]).some((key) => edit[key] !== saved[key]);
  return (
    <tr className="border-t border-line align-top">
      <td className="py-2 pr-2">
        {item.type}
        {item.generated && <span className="ml-1 text-xs text-ink-muted">(generated)</span>}
      </td>
      <td className="py-2 pr-2">
        <input
          aria-label={`Title for ${item.title}`}
          value={edit.title}
          onChange={(event) => setEdit({ ...edit, title: event.target.value })}
          className={INPUT}
        />
      </td>
      <td className="py-2 pr-2">
        <input
          aria-label={`Owner for ${item.title}`}
          value={edit.owner}
          onChange={(event) => setEdit({ ...edit, owner: event.target.value })}
          className={INPUT}
        />
      </td>
      <td className="py-2 pr-2">
        <input
          aria-label={`Tracker link for ${item.title}`}
          type="url"
          value={edit.trackerUrl}
          onChange={(event) => setEdit({ ...edit, trackerUrl: event.target.value })}
          className={INPUT}
        />
        {item.trackerUrl && (
          <a href={item.trackerUrl} target="_blank" rel="noreferrer" className="text-xs underline">
            Open tracker
          </a>
        )}
        {isUntracked(item) && (
          <span className="mt-1 inline-block rounded-full bg-warning-muted px-2 py-0.5 text-xs font-semibold text-warning">
            Untracked
          </span>
        )}
      </td>
      <td className="py-2 pr-2">
        <select
          aria-label={`State for ${item.title}`}
          value={item.state}
          disabled={pending}
          onChange={(event) => onPatch({ state: event.target.value as ActionItemState })}
          className={INPUT}
        >
          {ACTION_ITEM_STATES.map((state) => (
            <option key={state} value={state}>
              {state.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 pr-2">
        <input
          aria-label={`Due date for ${item.title}`}
          type="date"
          value={edit.dueAt}
          onChange={(event) => setEdit({ ...edit, dueAt: event.target.value })}
          className={INPUT}
        />
      </td>
      <td className="py-2">
        <button
          type="button"
          disabled={pending || !dirty || !edit.title.trim()}
          onClick={() =>
            onPatch({
              title: edit.title,
              owner: edit.owner || null,
              trackerUrl: edit.trackerUrl || null,
              dueAt: edit.dueAt ? new Date(edit.dueAt).toISOString() : null,
            })
          }
          className={BUTTON}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </td>
    </tr>
  );
}
