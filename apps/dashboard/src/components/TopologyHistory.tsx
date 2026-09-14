import { useState } from 'react';
import type { CredentialGetter } from '../lib/request-credentials';
import { useFetchResource } from '../lib/useFetchResource';
import { formatAbsoluteTime } from '../lib/time';

type Change = {
  upstream: string;
  downstream: string;
  environment: string;
  validFrom: string;
  validUntil: string | null;
};
const empty: Change[] = [];
const select = (body: unknown) => (body as { changes: Change[] }).changes;
function RecordedChanges({
  apiBaseUrl,
  getCredentials,
  onChange,
}: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  onChange: (at: string) => void;
}) {
  const { data, error, loading } = useFetchResource({
    apiBaseUrl,
    getCredentials,
    path: '/topology/history',
    initial: empty,
    select,
  });
  return (
    <div className="mt-3 text-xs">
      {loading ? (
        <p>Loading recorded changes…</p>
      ) : error ? (
        <p role="alert">Recorded changes could not be loaded. You can still choose a time below.</p>
      ) : data.length ? (
        <label>
          Recent recorded changes
          <select
            className="mt-1 block w-full min-w-0 rounded border border-line-strong bg-surface p-2"
            value=""
            onChange={(event) => {
              if (event.target.value) onChange(event.target.value);
            }}
          >
            <option value="">Choose a recorded version</option>
            {data.map((change, index) => (
              <option key={index} value={change.validFrom}>
                {formatAbsoluteTime(change.validFrom)} · {change.upstream} → {change.downstream} ·{' '}
                {change.environment || 'Unscoped'}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-ink-muted">
            Up to 100 recent versions. Choose any date below to inspect older records or deletion
            boundaries.
          </span>
        </label>
      ) : (
        <p>No recorded declarations yet.</p>
      )}
    </div>
  );
}

/** Historical mode shows recorded declarations only, never today's runtime as past evidence. */
export function TopologyHistory({
  at,
  onChange,
  apiBaseUrl,
  getCredentials,
}: {
  at: string;
  onChange: (at: string) => void;
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
}) {
  const [value, setValue] = useState(() => {
    if (!at) return '';
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  });
  const [open, setOpen] = useState(Boolean(at));
  return (
    <>
      {at && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded border border-info-line bg-info-soft p-3 text-sm">
          <p>Historical declarations · {formatAbsoluteTime(at)}</p>
          <button type="button" className="text-info underline" onClick={() => onChange('')}>
            Return to live topology
          </button>
        </div>
      )}
      <details
        className="mb-4 rounded border border-line p-3 text-sm"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer font-medium">
          {at ? 'Historical declarations' : 'Review declaration history'}
        </summary>
        <p className="mt-2 text-xs text-ink-muted">
          Review relationships as recorded at a past time. History starts when tracking was enabled;
          runtime health, ownership and incidents are not reconstructed.
        </p>
        {open && (
          <RecordedChanges
            apiBaseUrl={apiBaseUrl}
            getCredentials={getCredentials}
            onChange={onChange}
          />
        )}
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (value && Number.isFinite(new Date(value).getTime()))
              onChange(new Date(value).toISOString());
          }}
        >
          <label className="text-xs">
            Local date and time
            <input
              required
              type="datetime-local"
              step="1"
              className="mt-1 block rounded border border-line-strong bg-surface p-2"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <button className="rounded border border-line-strong px-3 py-2">
            View recorded relationships
          </button>
        </form>
      </details>
    </>
  );
}
