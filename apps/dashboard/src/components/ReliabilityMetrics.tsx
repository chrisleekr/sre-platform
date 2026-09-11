const integer = new Intl.NumberFormat('en-US');
const utcTime = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

/** Consistent number and UTC-period formatting for the reliability report. */
export const reliabilityFormat = {
  integer: (value: number) => integer.format(value),
  quantity: (value: number, singular: string, plural = `${singular}s`) =>
    `${integer.format(value)} ${value === 1 ? singular : plural}`,
  age: (seconds: number | null) =>
    seconds === null ? 'No data' : `${Math.round(seconds / 60)} min`,
  percentage: (value: number | null) => (value === null ? 'N/A' : `${Math.round(value * 100)}%`),
  decimal: (value: number | null) => (value === null ? 'N/A' : value.toFixed(2)),
  range: (value: { start: string | Date; end: string | Date }) =>
    `${utcTime.format(new Date(value.start))} to ${utcTime.format(new Date(value.end))}`,
  utc: (value: string | Date) => utcTime.format(new Date(value)),
};

/** Current value and equal-elapsed comparison used in the reliability summary rail. */
export function ReliabilitySummaryMetric(props: {
  label: string;
  value: string;
  previous: string;
  detail: string;
}) {
  return (
    <div role="group" aria-label={props.label} className="min-w-0 bg-surface p-4 sm:p-5">
      <dt className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {props.label}
      </dt>
      <dd className="mt-2 font-instrument text-3xl font-semibold tabular-nums tracking-tight text-ink">
        {props.value}
      </dd>
      <dd className="mt-1 text-xs font-medium text-ink-secondary">Previous: {props.previous}</dd>
      <dd className="mt-3 text-xs leading-5 text-ink-muted">{props.detail}</dd>
    </div>
  );
}

/** Label, value, and optional comparison detail used in compact reliability cards. */
export function ReliabilityMetricRow(props: { label: string; value: string; detail?: string }) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="flex min-w-0 items-start justify-between gap-4 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0"
    >
      <div className="min-w-0">
        <dt className="text-sm font-medium text-ink-secondary">{props.label}</dt>
        {props.detail && (
          <dd className="mt-0.5 text-xs leading-5 text-ink-muted">{props.detail}</dd>
        )}
      </div>
      <dd className="shrink-0 font-instrument text-sm font-semibold tabular-nums text-ink">
        {props.value}
      </dd>
    </div>
  );
}
