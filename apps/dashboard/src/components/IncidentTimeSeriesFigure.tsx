import { formatAbsoluteTime } from '../lib/time';
import type { EvidenceDetail } from '../lib/types';
import { useId, useState } from 'react';

type TimeSeriesProjection = Extract<EvidenceDetail['projection'], { kind: 'time_series' }>;
type Series = TimeSeriesProjection['series'][number];

const colors = [
  'var(--sre-assessment)',
  'var(--sre-info)',
  'var(--sre-success)',
  'var(--sre-warning)',
  'var(--sre-critical)',
];

function SeriesFigure({
  detail,
  projection,
  series,
  unit,
  groupIndex,
  compact = false,
}: {
  detail: EvidenceDetail;
  projection: TimeSeriesProjection;
  series: Series[];
  unit: string | null;
  groupIndex: number;
  compact?: boolean;
}) {
  const [page, setPage] = useState(0);
  const tablePoints = series.flatMap((item) =>
    item.points.map((point) => ({ ...point, name: item.name })),
  );
  const points = series.flatMap((item) => item.points);
  const times = points.map((point) => Date.parse(point.timestamp));
  const values = points.map((point) => point.value);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const timeSpan = maxTime - minTime;
  const valueSpan = maxValue - minValue;
  const x = (value: number) => (timeSpan === 0 ? 332 : 48 + ((value - minTime) / timeSpan) * 568);
  const y = (value: number) =>
    valueSpan === 0 ? 108 : 16 + (1 - (value - minValue) / valueSpan) * 184;
  const reportedUnit = unit ?? 'unit not reported';
  const titleId = `evidence-chart-${useId()}-${groupIndex}`;
  const tickTime = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const fromLabel = projection.from ? formatAbsoluteTime(projection.from) : 'not reported';
  const toLabel = projection.to ? formatAbsoluteTime(projection.to) : 'not reported';

  return (
    <figure className="min-w-0 max-w-full overflow-hidden rounded-md border border-line p-3">
      <div className="min-w-0 overflow-x-auto">
        <svg
          viewBox="0 0 640 230"
          role="img"
          aria-labelledby={titleId}
          className={
            compact ? 'h-auto w-full' : 'h-auto min-w-[32rem] max-w-none sm:min-w-0 sm:w-full'
          }
        >
          <title id={titleId}>{`${projection.source} metric evidence, ${reportedUnit}`}</title>
          <line x1="48" y1="200" x2="616" y2="200" stroke="var(--sre-line-strong)" />
          <line x1="48" y1="16" x2="48" y2="200" stroke="var(--sre-line-strong)" />
          <text x="4" y="22" fontSize="11" fill="var(--sre-ink-muted)">
            {maxValue.toPrecision(4)}
          </text>
          <text x="4" y="202" fontSize="11" fill="var(--sre-ink-muted)">
            {minValue.toPrecision(4)}
          </text>
          <text x="48" y="220" fontSize="11" fill="var(--sre-ink-muted)">
            {Number.isFinite(minTime) ? tickTime.format(new Date(minTime)) : ''}
          </text>
          <text x="616" y="220" textAnchor="end" fontSize="11" fill="var(--sre-ink-muted)">
            {Number.isFinite(maxTime) ? tickTime.format(new Date(maxTime)) : ''}
          </text>
          {series.map((item, index) => {
            const color = colors[index % colors.length];
            return item.points.length === 1 ? (
              <circle
                key={`${item.name}:${index}`}
                cx={x(Date.parse(item.points[0]!.timestamp))}
                cy={y(item.points[0]!.value)}
                r="4"
                fill={color}
              />
            ) : (
              <polyline
                key={`${item.name}:${index}`}
                fill="none"
                stroke={color}
                strokeWidth="2"
                points={item.points
                  .map((point) => `${x(Date.parse(point.timestamp))},${y(point.value)}`)
                  .join(' ')}
              />
            );
          })}
        </svg>
      </div>
      <figcaption className="mt-2 min-w-0 text-xs text-ink-muted">
        <span className="font-medium text-ink-secondary">{projection.source}</span> · {reportedUnit}{' '}
        · {fromLabel} to {toLabel}
        <span className="block">Recorded {formatAbsoluteTime(detail.recordedAt)}</span>
      </figcaption>
      {!compact && (
        <ul className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs">
          {series.map((item, index) => (
            <li key={`${item.name}:${index}`} className="flex min-w-0 items-center gap-1">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: colors[index % colors.length] }}
              />
              <span className="break-all">
                {item.name} · {reportedUnit}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!compact && projection.query && (
        <details className="mt-3 min-w-0">
          <summary className="cursor-pointer text-xs font-semibold text-ink-secondary">
            View metric query
          </summary>
          <code className="mt-2 block max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface-subtle p-2 font-instrument text-xs text-ink-secondary">
            {projection.query}
          </code>
        </details>
      )}
      {!compact && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-secondary">
            View chart data table
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">{`Metric evidence data, ${reportedUnit}`}</caption>
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th className="px-2 py-1">Series</th>
                  <th className="px-2 py-1">Timestamp</th>
                  <th className="px-2 py-1">Value</th>
                </tr>
              </thead>
              <tbody>
                {tablePoints.slice(page * 25, (page + 1) * 25).map((point, pointIndex) => (
                  <tr key={pointIndex} className="border-t border-line">
                    <td className="break-all px-2 py-1">{point.name}</td>
                    <td className="px-2 py-1">{point.timestamp}</td>
                    <td className="px-2 py-1">{point.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            Projected data, up to 20 series and 1000 points per series.
          </p>
          {tablePoints.length > 25 && (
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                className="min-h-11 underline"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous points
              </button>
              <span className="py-3">
                {page + 1} / {Math.ceil(tablePoints.length / 25)}
              </span>
              <button
                type="button"
                className="min-h-11 underline"
                disabled={(page + 1) * 25 >= tablePoints.length}
                onClick={() => setPage(page + 1)}
              >
                Next points
              </button>
            </div>
          )}
        </details>
      )}
    </figure>
  );
}

export function IncidentTimeSeriesFigure({
  detail,
  compact = false,
}: {
  detail: EvidenceDetail;
  compact?: boolean;
}) {
  if (detail.projection.kind !== 'time_series') return null;
  const projection = detail.projection;
  const groups = new Map<string | null, Series[]>();
  for (const item of projection.series) {
    groups.set(item.unit, [...(groups.get(item.unit) ?? []), item]);
  }

  return (
    <div className="grid min-w-0 max-w-full gap-3 overflow-hidden">
      {[...groups.entries()]
        .slice(0, compact ? 1 : groups.size)
        .map(([unit, series], groupIndex) => (
          <SeriesFigure
            key={unit ?? 'unreported'}
            detail={detail}
            projection={projection}
            series={series}
            unit={unit}
            groupIndex={groupIndex}
            compact={compact}
          />
        ))}
    </div>
  );
}
