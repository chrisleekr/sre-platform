import { INFRA_STALE_AFTER_MS } from '../lib/types';
import type { TopologyCoverage as Coverage } from '../lib/topology';
import { relativeTime } from '../lib/time';

/** Collection status remains visible even when no runtime resources were returned. */
export function TopologyCoverage({ sources }: { sources: Coverage[] }) {
  if (sources.length === 0) return null;
  const now = Date.now();
  const rows = sources.map((source) => {
    const observed = source.observedAt ? Date.parse(source.observedAt) : NaN;
    const stale = Number.isFinite(observed) && now - observed > INFRA_STALE_AFTER_MS;
    return { ...source, stale };
  });
  const incomplete = rows.filter((source) => source.state !== 'complete' || source.stale).length;
  return (
    <details
      className="mb-4 rounded-md border border-line bg-surface p-3 text-sm"
      open={incomplete > 0}
    >
      <summary className="cursor-pointer font-medium">
        Runtime evidence ·{' '}
        {incomplete
          ? `${incomplete} of ${rows.length} sources need attention`
          : `${rows.length} sources complete`}
      </summary>
      <p className="mt-2 text-xs text-ink-muted">
        Pod health is not service availability. Missing or partial collection cannot establish
        healthy runtime.
      </p>
      <ul className="mt-2 space-y-2 text-xs">
        {rows.map((source) => (
          <li
            key={source.dataSourceId}
            className="flex flex-wrap items-baseline justify-between gap-2"
          >
            <a
              className="text-info underline"
              href={`/w/connectors?connection=${encodeURIComponent(source.dataSourceId)}`}
            >
              {source.dataSourceName}
            </a>
            <span
              className={
                source.state === 'complete' && !source.stale ? 'text-ink-muted' : 'text-warning'
              }
            >
              {source.state === 'partial'
                ? 'Partial inventory · collection limit reached'
                : source.state === 'unknown'
                  ? 'Collection completeness unknown · waiting for a new poll'
                  : source.state === 'unavailable'
                    ? 'Current inventory unavailable'
                    : 'Complete pod inventory'}
              {source.stale ? ' · Inventory is stale' : ''}
              {source.observedAt
                ? ` · observed ${relativeTime(source.observedAt, now)}`
                : source.lastSucceededAt
                  ? ` · last successful poll ${relativeTime(source.lastSucceededAt, now)}`
                  : ''}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
