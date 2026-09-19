import type { LlmProvider, LlmRuntime, LlmUsageSummary } from '@sre/contracts';
import { Money } from './Money';
import { StatePanel } from './PageState';

const DAY_MS = 86_400_000;

const integer = new Intl.NumberFormat('en-US');

const OPERATION_LABEL: Record<string, string> = {
  classify: 'Classify inbound alerts',
  characterize: 'Characterize incidents',
  investigate: 'Initial investigation',
  reassess: 'Reassess evidence',
  resume: 'Answer responders',
  'verify-recovery': 'Verify recovery',
  'interpret-image': 'Interpret screenshots',
  'runbook-distill': 'Distill runbooks',
  'runbook-decide': 'Decide runbook updates',
  'postmortem-generate': 'Generate postmortems',
  'assessment-grade': 'Grade root-cause assessments',
};

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  'custom-anthropic': 'Anthropic-compatible',
  bedrock: 'Amazon Bedrock',
  openai: 'OpenAI',
};

const RUNTIME_LABEL: Record<LlmRuntime, string> = {
  'claude-agent-sdk': 'Claude Agent SDK',
  'openai-chat': 'OpenAI Chat Completions',
};

export function CostSummary({ usage }: { usage: LlmUsageSummary }) {
  const tokens =
    usage.tokens.input + usage.tokens.output + usage.tokens.cacheRead + usage.tokens.cacheWrite;
  const running = Math.max(0, usage.invocations - usage.succeeded - usage.failed);

  return (
    <section
      aria-labelledby="usage-summary-title"
      className="rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="usage-summary-title" className="font-medium text-ink">
            Summary
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Configured cost uses the price snapshot stored with each invocation.
          </p>
        </div>
        {usage.unpriced > 0 && (
          <span className="rounded-full bg-warning-muted px-2.5 py-1 text-xs font-semibold text-warning">
            {usage.unpriced} unpriced
          </span>
        )}
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-md bg-surface-subtle p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Configured cost
          </dt>
          <dd className="mt-1 text-xl font-semibold text-ink">
            <Money amount={usage.configuredCostUsd} />
          </dd>
        </div>
        <div className="rounded-md bg-surface-subtle p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Invocations
          </dt>
          <dd className="mt-1 text-xl font-semibold text-ink">
            {integer.format(usage.invocations)}
          </dd>
          <dd className="text-xs text-ink-muted">
            {integer.format(usage.succeeded)} succeeded, {integer.format(usage.failed)} failed
            {running > 0 ? `, ${integer.format(running)} running` : ''}
          </dd>
        </div>
        <div className="rounded-md bg-surface-subtle p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Tokens</dt>
          <dd className="mt-1 text-xl font-semibold text-ink">{integer.format(tokens)}</dd>
          <dd className="mt-1 grid grid-cols-2 gap-x-2 text-xs text-ink-muted">
            <span>{integer.format(usage.tokens.input)} input</span>
            <span>{integer.format(usage.tokens.output)} output</span>
            <span>{integer.format(usage.tokens.cacheRead)} cache read</span>
            <span>{integer.format(usage.tokens.cacheWrite)} cache write</span>
          </dd>
        </div>
        <div className="rounded-md bg-surface-subtle p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Provider estimate
          </dt>
          <dd className="mt-1 text-xl font-semibold text-ink">
            {usage.providerEstimatedCostUsd === null ? (
              'Not reported'
            ) : (
              <Money amount={usage.providerEstimatedCostUsd} />
            )}
          </dd>
          <dd className="text-xs text-ink-muted">Reference only, not a billing statement</dd>
        </div>
      </dl>

      {(usage.missingUsage > 0 || usage.unpriced > 0) && (
        <div className="mt-3 rounded-md border border-warning-line bg-warning-soft p-3 text-sm text-warning">
          {usage.unpriced > 0 && (
            <p>{usage.unpriced} invocation(s) have token usage but no configured price.</p>
          )}
          {usage.missingUsage > 0 && (
            <p>
              {usage.missingUsage} invocation(s) have not reported token usage. This can include
              work still running.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function UsageBreakdowns({ usage }: { usage: LlmUsageSummary }) {
  if (usage.invocations === 0) {
    return (
      <StatePanel
        state="empty"
        title="No model usage in this time range."
        description="Choose a wider range or wait for the next model-backed SRE action."
      />
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section
        aria-labelledby="usage-workload-title"
        className="rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="usage-workload-title" className="font-medium text-ink">
          By workload
        </h2>
        <p className="mt-1 text-sm text-ink-muted">Which SRE actions consumed the budget.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="py-2 pr-3 font-semibold">Workload</th>
                <th className="py-2 pr-3 text-right font-semibold">Calls</th>
                <th className="py-2 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.byOperation.map((row) => (
                <tr key={row.operation} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3">{OPERATION_LABEL[row.operation] ?? row.operation}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{row.invocations}</td>
                  <td className="py-2 text-right tabular-nums">
                    <Money amount={row.configuredCostUsd} />
                    {row.unpriced > 0 && (
                      <span className="ml-2 text-xs text-warning">+ {row.unpriced} unpriced</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        aria-labelledby="usage-model-title"
        className="rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="usage-model-title" className="font-medium text-ink">
          By model
        </h2>
        <p className="mt-1 text-sm text-ink-muted">Runtime and provider mix behind the spend.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="py-2 pr-3 font-semibold">Model</th>
                <th className="py-2 pr-3 text-right font-semibold">Calls</th>
                <th className="py-2 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.byModel.map((row) => (
                <tr
                  key={`${row.runtime}:${row.provider}:${row.model}`}
                  className="border-b border-line last:border-0"
                >
                  <td className="py-2 pr-3">
                    <span className="block font-medium text-ink">{row.model}</span>
                    <span className="text-xs text-ink-muted">
                      {PROVIDER_LABEL[row.provider]} · {RUNTIME_LABEL[row.runtime]}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{row.invocations}</td>
                  <td className="py-2 text-right tabular-nums">
                    <Money amount={row.configuredCostUsd} />
                    {row.unpriced > 0 && (
                      <span className="ml-2 text-xs text-warning">+ {row.unpriced} unpriced</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function UsageTrend({ usage }: { usage: LlmUsageSummary }) {
  if (usage.series.length === 0) return null;
  const width = 640;
  const height = 190;
  const chartTop = 20;
  const chartBottom = 150;
  const chartHeight = chartBottom - chartTop;
  const chartLeft = 56;
  const chartRight = width - 16;
  const plotWidth = chartRight - chartLeft;
  const maxCost = Math.max(...usage.series.map((point) => point.configuredCostUsd), 0.000001);
  const from = new Date(usage.from ?? usage.series[0]!.bucketAt).getTime();
  const to = new Date(usage.to ?? usage.series.at(-1)!.bucketAt).getTime();
  const range = Math.max(DAY_MS, to - from);
  const daySlots = Math.max(1, Math.ceil(range / DAY_MS));
  const slot = plotWidth / daySlots;
  const barWidth = Math.max(3, Math.min(24, slot * 0.64));
  const date = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <section
      aria-labelledby="usage-trend-title"
      className="rounded-lg border border-line bg-surface p-4"
    >
      <div>
        <h2 id="usage-trend-title" className="font-medium text-ink">
          Cost over time
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Daily configured cost in UTC. Red markers identify days with failed invocations.
        </p>
      </div>
      <div className="mt-4 min-w-0 overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Daily configured model cost"
          className="h-auto min-w-[34rem] w-full"
        >
          <line
            x1={chartLeft}
            y1={chartBottom}
            x2={chartRight}
            y2={chartBottom}
            stroke="var(--sre-line-strong)"
          />
          <text x="4" y={chartTop + 4} fontSize="11" fill="var(--sre-ink-muted)">
            ${maxCost.toFixed(2)}
          </text>
          <text x="34" y={chartBottom + 4} fontSize="11" fill="var(--sre-ink-muted)">
            $0
          </text>
          {usage.series.map((point, index) => {
            const observedAt = new Date(point.bucketAt).getTime();
            const position = Math.min(1, Math.max(0, (observedAt - from) / range));
            const x = chartLeft + position * (plotWidth - barWidth);
            const barHeight = Math.max(2, (point.configuredCostUsd / maxCost) * chartHeight);
            return (
              <g key={point.bucketAt}>
                <title>{`${date.format(new Date(point.bucketAt))}: ${point.invocations} calls, $${point.configuredCostUsd.toFixed(6)}, ${point.failed} failed`}</title>
                <rect
                  x={x}
                  y={chartBottom - barHeight}
                  width={barWidth}
                  height={barHeight}
                  rx="2"
                  fill="var(--sre-assessment)"
                />
                {point.failed > 0 && (
                  <circle
                    cx={x + barWidth / 2}
                    cy={chartBottom - barHeight - 7}
                    r="3.5"
                    fill="var(--sre-critical)"
                  />
                )}
                {(index === 0 || index === usage.series.length - 1) && (
                  <text
                    x={x + barWidth / 2}
                    y={chartBottom + 22}
                    textAnchor="middle"
                    fontSize="11"
                    fill="var(--sre-ink-muted)"
                  >
                    {date.format(new Date(point.bucketAt))}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-sm font-semibold text-ink-secondary">
          View daily data
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="py-2">Day</th>
                <th className="py-2 text-right">Calls</th>
                <th className="py-2 text-right">Failed</th>
                <th className="py-2 text-right">Tokens</th>
                <th className="py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.series.map((point) => (
                <tr key={point.bucketAt} className="border-b border-line last:border-0">
                  <td className="py-2">{date.format(new Date(point.bucketAt))}</td>
                  <td className="py-2 text-right tabular-nums">
                    {integer.format(point.invocations)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{integer.format(point.failed)}</td>
                  <td className="py-2 text-right tabular-nums">{integer.format(point.tokens)}</td>
                  <td className="py-2 text-right tabular-nums">
                    <Money amount={point.configuredCostUsd} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
