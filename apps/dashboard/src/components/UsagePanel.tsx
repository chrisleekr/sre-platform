import { useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { formatAbsoluteTime } from '../lib/time';
import { useLlmUsage } from '../lib/useLlmUsage';
import { PageHeader } from './PageHeader';
import { StatePanel } from './PageState';
import { CostSummary, UsageBreakdowns, UsageTrend } from './UsageSections';

const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 366;

type Preset = '1' | '7' | '30' | 'custom';
interface UsageWindow {
  from: string;
  to: string;
}

function relativeWindow(days: number, now = new Date()): UsageWindow {
  return {
    from: new Date(now.getTime() - days * DAY_MS).toISOString(),
    to: now.toISOString(),
  };
}

function localDateValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function customWindow(
  fromValue: string,
  throughValue: string,
): { window: UsageWindow; error: null } | { window: null; error: string } {
  if (!fromValue || !throughValue) return { window: null, error: 'Choose both dates.' };
  const from = new Date(`${fromValue}T00:00:00`);
  const to = new Date(`${throughValue}T00:00:00`);
  to.setDate(to.getDate() + 1);
  to.setMilliseconds(-1);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    return { window: null, error: 'The start date must not be after the end date.' };
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return { window: null, error: `Choose a range of ${MAX_WINDOW_DAYS} days or less.` };
  }
  return { window: { from: from.toISOString(), to: to.toISOString() }, error: null };
}

export function UsagePanel() {
  const { getCredentials } = useSession();
  const now = new Date();
  const [preset, setPreset] = useState<Preset>('30');
  const [window, setWindow] = useState<UsageWindow>(() => relativeWindow(30));
  const [customFrom, setCustomFrom] = useState(() =>
    localDateValue(new Date(now.getTime() - 30 * DAY_MS)),
  );
  const [customThrough, setCustomThrough] = useState(() => localDateValue(now));
  const [customError, setCustomError] = useState<string | null>(null);
  const report = useLlmUsage({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    from: window.from,
    to: window.to,
  });

  const accessDenied = report.error && report.errorStatus === 403;

  return (
    <section>
      <PageHeader
        title="Usage & Cost"
        description="Monitor the model-backed SRE work consuming tokens and budget."
      />

      <section
        aria-label="Usage window"
        className="mb-4 rounded-lg border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-col gap-1 text-sm font-medium">
            Time range
            <select
              value={preset}
              onChange={(event) => {
                const next = event.target.value as Preset;
                setPreset(next);
                setCustomError(null);
                if (next !== 'custom') setWindow(relativeWindow(Number(next)));
              }}
              className="min-h-10 rounded border border-line-strong bg-surface px-3 py-2 font-normal"
            >
              <option value="1">Last 24 hours</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="custom">Custom dates</option>
            </select>
          </label>

          {preset === 'custom' && (
            <>
              <label className="flex flex-col gap-1 text-sm font-medium">
                From
                <input
                  type="date"
                  value={customFrom}
                  aria-describedby={customError ? 'usage-window-error' : undefined}
                  onChange={(event) => setCustomFrom(event.target.value)}
                  className="min-h-10 rounded border border-line-strong px-3 py-2 font-normal"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                Through
                <input
                  type="date"
                  value={customThrough}
                  aria-describedby={customError ? 'usage-window-error' : undefined}
                  onChange={(event) => setCustomThrough(event.target.value)}
                  className="min-h-10 rounded border border-line-strong px-3 py-2 font-normal"
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  const result = customWindow(customFrom, customThrough);
                  setCustomError(result.error);
                  if (result.window) setWindow(result.window);
                }}
                className="min-h-10 rounded bg-strong px-4 py-2 text-sm font-semibold text-on-strong"
              >
                Apply
              </button>
            </>
          )}
        </div>
        {customError && (
          <p id="usage-window-error" role="alert" className="mt-2 text-sm text-critical">
            {customError}
          </p>
        )}
        {!report.loading && !report.error && report.usage.from && report.usage.to && (
          <p className="mt-2 text-xs text-ink-muted">
            Showing {formatAbsoluteTime(report.usage.from)} to {formatAbsoluteTime(report.usage.to)}
            .
          </p>
        )}
      </section>

      {report.loading && (
        <StatePanel state="loading" title="Loading usage and cost…" skeleton="report" />
      )}
      {!report.loading && report.error && (
        <StatePanel
          state={accessDenied ? 'access' : 'error'}
          title={
            accessDenied
              ? 'Platform-operator access is required to view usage and cost.'
              : 'Failed to load usage and cost.'
          }
          description={
            accessDenied
              ? 'This account cannot view platform-wide model consumption.'
              : 'The usage report could not be retrieved.'
          }
          onRetry={accessDenied ? undefined : report.refetch}
        />
      )}
      {!report.loading && !report.error && (
        <div className="space-y-4">
          <CostSummary usage={report.usage} />
          <UsageTrend usage={report.usage} />
          <UsageBreakdowns usage={report.usage} />
        </div>
      )}
    </section>
  );
}
