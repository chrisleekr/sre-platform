import { useState } from 'react';
import type { StatusCakeUptimeTest } from '../../lib/connector-api/statuscake';

/** Checkbox list of StatusCake uptime tests. A checked test opens incidents. */
export function UptimeTestPicker({
  tests,
  mode,
  isChecked,
  onToggle,
  onToggleAll,
}: {
  tests: StatusCakeUptimeTest[];
  mode: 'auto' | 'custom';
  isChecked(id: string): boolean;
  onToggle(id: string, checked: boolean): void;
  onToggleAll(ids: string[], checked: boolean): void;
}) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? tests.filter((test) =>
        [test.name, test.url ?? '', test.id].some((value) => value.toLowerCase().includes(needle)),
      )
    : tests;
  const checkedCount = tests.filter((test) => isChecked(test.id)).length;
  const visibleIds = visible.map((test) => test.id);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="min-w-0 flex-1 text-sm font-medium">
          Search uptime tests
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or URL"
            className="sre-field mt-1 block w-full"
          />
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            className="sre-action"
            onClick={() => onToggleAll(visibleIds, true)}
          >
            Select all
          </button>
          <button
            type="button"
            className="sre-action"
            onClick={() => onToggleAll(visibleIds, false)}
          >
            Clear
          </button>
        </div>
      </div>
      <p className="text-sm text-ink-muted" aria-live="polite">
        {checkedCount} of {tests.length} tests will open incidents.
        {mode === 'auto' && ' Tests you add in StatusCake later are included automatically.'}
      </p>
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded border border-line">
        {visible.map((test) => (
          <li key={test.id}>
            <label className="flex min-w-0 items-start gap-3 p-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={isChecked(test.id)}
                onChange={(event) => onToggle(test.id, event.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium">{test.name}</span>
                <span className="block break-all text-xs text-ink-muted">
                  {test.url ?? `Test ${test.id}`}
                </span>
              </span>
              <span className="shrink-0 text-xs">
                {test.paused ? (
                  <span className="text-ink-muted">Paused</span>
                ) : test.status === 'down' ? (
                  <span className="text-critical">Down</span>
                ) : test.status === 'up' ? (
                  <span className="text-success">Up</span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
        {visible.length === 0 && (
          <li className="p-3 text-sm text-ink-muted">
            {tests.length === 0
              ? 'This StatusCake account has no uptime tests yet.'
              : 'No uptime tests match this search.'}
          </li>
        )}
      </ul>
    </div>
  );
}
