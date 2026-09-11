import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SignalSpine, type SignalFacet, type SignalTone } from './SignalSpine';

const VALUE_TONE: Record<SignalTone, string> = {
  critical: 'text-critical',
  warning: 'text-warning',
  info: 'text-info',
  success: 'text-success',
  assessment: 'text-assessment',
  unknown: 'text-ink',
};

export interface OperationalMetric {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  tone?: SignalTone;
  href?: string;
}

export function OperationalBand({
  eyebrow,
  title,
  description,
  facets,
  metrics,
  statusRail,
}: {
  eyebrow: string;
  title: string;
  description: string;
  facets: readonly SignalFacet[];
  metrics: readonly OperationalMetric[];
  statusRail?: ReactNode;
}) {
  const metricGrid =
    metrics.length >= 4
      ? 'sm:grid-cols-4'
      : metrics.length === 3
        ? 'sm:grid-cols-3'
        : 'sm:grid-cols-2';
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="grid min-w-0 xl:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="flex min-w-0 gap-3 border-b border-line bg-surface-subtle p-4 xl:border-b-0 xl:border-r">
          <SignalSpine facets={facets} />
          <div className="min-w-0">
            <p className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              {eyebrow}
            </p>
            <h2 className="sre-display mt-1 text-lg text-ink">{title}</h2>
            <p className="mt-1 text-xs leading-5 text-ink-muted">{description}</p>
          </div>
        </div>
        <div className="min-w-0">
          {statusRail}
          <dl className={`grid min-w-0 grid-cols-2 divide-x divide-y divide-line ${metricGrid}`}>
            {metrics.map((metric) => {
              const content = (
                <>
                  <dt className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                    {metric.label}
                  </dt>
                  <dd
                    className={`mt-1 text-xl font-semibold tabular-nums ${VALUE_TONE[metric.tone ?? 'unknown']}`}
                  >
                    {metric.value}
                  </dd>
                  <dd className="mt-1 text-xs leading-5 text-ink-muted">{metric.detail}</dd>
                </>
              );
              return (
                <div key={metric.label} className="min-w-0 p-4">
                  {metric.href ? (
                    <Link
                      to={metric.href}
                      className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
                    >
                      {content}
                    </Link>
                  ) : (
                    content
                  )}
                </div>
              );
            })}
          </dl>
        </div>
      </div>
    </section>
  );
}
