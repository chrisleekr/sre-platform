import { useId, type ReactNode } from 'react';
import type { GraphNode, BlastHighlight } from '../lib/topology';
const STATUS_COLOUR = {
  incident: 'var(--sre-critical-solid)',
  attention: 'var(--sre-warning-solid)',
  stale: 'var(--sre-warning)',
  healthy: 'var(--sre-success-solid)',
  unknown: 'var(--sre-ink-faint)',
} as const;

/** Health is the primary topology encoding. Deploy recency remains visible in service detail. */
export function serviceStatusColour(status: GraphNode['status']): string {
  return STATUS_COLOUR[status ?? 'unknown'];
}

// Blast-radius overlay ring colour by highlight tier.
export const HIGHLIGHT_STROKE: Record<BlastHighlight, string> = {
  affected: 'var(--sre-critical-solid)',
  direct: 'var(--sre-warning-solid)',
  indirect: 'var(--sre-warning)',
  insulated: 'var(--sre-info)',
  unclassified: 'var(--sre-assessment)',
};

export const EDGE_STROKE = 'var(--sre-line-strong)';
export const CIRCUIT_STROKE = 'var(--sre-info)';

function LegendItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <svg aria-hidden="true" viewBox="0 0 32 20" className="h-5 w-8 shrink-0">
        {children}
      </svg>
      <span className="min-w-0 break-words">{label}</span>
    </div>
  );
}

/** Key for every visible graph encoding. */
export function TopologyLegend() {
  const legendArrowId = useId();
  return (
    <div
      aria-label="Topology legend"
      className="grid min-w-0 gap-x-5 gap-y-2 rounded border border-line bg-surface-subtle p-3 text-xs text-ink-muted sm:grid-cols-2 lg:grid-cols-3"
    >
      <LegendItem label="Active incident">
        <circle data-legend="status-incident" cx="16" cy="10" r="6" fill={STATUS_COLOUR.incident} />
      </LegendItem>
      <LegendItem label="Runtime attention">
        <circle
          data-legend="status-attention"
          cx="16"
          cy="10"
          r="6"
          fill={STATUS_COLOUR.attention}
        />
      </LegendItem>
      <LegendItem label="Stale telemetry">
        <circle data-legend="status-stale" cx="16" cy="10" r="6" fill={STATUS_COLOUR.stale} />
      </LegendItem>
      <LegendItem label="Healthy runtime">
        <circle data-legend="status-healthy" cx="16" cy="10" r="6" fill={STATUS_COLOUR.healthy} />
      </LegendItem>
      <LegendItem label="No live telemetry">
        <circle data-legend="status-unknown" cx="16" cy="10" r="6" fill={STATUS_COLOUR.unknown} />
      </LegendItem>
      <LegendItem label="Selected service">
        <circle
          data-legend="selected"
          cx="16"
          cy="10"
          r="6"
          fill={STATUS_COLOUR.unknown}
          stroke="var(--sre-ink)"
          strokeWidth="2.5"
        />
      </LegendItem>
      <LegendItem label="Affected service">
        <circle
          data-legend="affected"
          cx="16"
          cy="10"
          r="8"
          fill="none"
          stroke={HIGHLIGHT_STROKE.affected}
          strokeWidth="2.5"
        />
      </LegendItem>
      <LegendItem label="Synchronous exposure">
        <circle
          data-legend="direct"
          cx="16"
          cy="10"
          r="8"
          fill="none"
          stroke={HIGHLIGHT_STROKE.direct}
          strokeWidth="2.5"
        />
      </LegendItem>
      <LegendItem label="Async exposure">
        <circle
          data-legend="indirect"
          cx="16"
          cy="10"
          r="8"
          fill="none"
          stroke={HIGHLIGHT_STROKE.indirect}
          strokeWidth="2.5"
        />
      </LegendItem>
      <LegendItem label="Dependency behavior unknown">
        <circle
          data-legend="unclassified"
          cx="16"
          cy="10"
          r="8"
          fill="none"
          stroke={HIGHLIGHT_STROKE.unclassified}
          strokeWidth="2.5"
        />
      </LegendItem>
      <LegendItem label="Synchronous dependency">
        <line data-legend="sync" x1="3" y1="10" x2="29" y2="10" stroke={EDGE_STROKE} />
      </LegendItem>
      <LegendItem label="Breaker on exposure path">
        <circle
          data-legend="insulated"
          cx="16"
          cy="10"
          r="8"
          fill="none"
          stroke={HIGHLIGHT_STROKE.insulated}
          strokeWidth="2.5"
        />
      </LegendItem>
      <LegendItem label="Asynchronous dependency">
        <line
          data-legend="async"
          x1="3"
          y1="10"
          x2="29"
          y2="10"
          stroke={EDGE_STROKE}
          strokeDasharray="4 3"
        />
      </LegendItem>
      <LegendItem label="Mixed call types across environments">
        <line x1="3" y1="10" x2="29" y2="10" stroke={EDGE_STROKE} strokeDasharray="8 3 2 3" />
      </LegendItem>
      <LegendItem label="Circuit breaker">
        <line data-legend="circuit" x1="3" y1="10" x2="29" y2="10" stroke={CIRCUIT_STROKE} />
      </LegendItem>
      <LegendItem label="Mixed circuit-breaker declarations">
        <line
          data-legend="circuit-mixed"
          x1="3"
          y1="10"
          x2="29"
          y2="10"
          stroke="var(--sre-warning-solid)"
        />
      </LegendItem>
      <LegendItem label="Arrow points to dependency">
        <defs>
          <marker
            id={legendArrowId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="var(--sre-ink-faint)" />
          </marker>
        </defs>
        <line
          data-legend="arrow"
          x1="3"
          y1="10"
          x2="27"
          y2="10"
          stroke="var(--sre-ink-faint)"
          markerEnd={`url(#${legendArrowId})`}
        />
      </LegendItem>
    </div>
  );
}
