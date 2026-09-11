export const SIGNAL_QUEUE_COPY = {
  ticket: {
    title: 'Tickets needing review',
    empty: 'No tickets need review.',
    description: 'Deferred reliability risks appear here until reviewed or promoted.',
  },
  investigate: {
    title: 'Investigation routes',
    empty: 'No retained investigation routes.',
    description: 'Signals routed to incident investigation appear here for audit.',
  },
  log: {
    title: 'Logged context',
    empty: 'No retained context signals.',
    description: 'Low-risk observations kept for later correlation appear here.',
  },
} as const;

/** Compact operational status rail above the signal queue. */
export function SignalsOverview(props: {
  visible: number;
  disposition: 'investigate' | 'ticket' | 'log';
  promotionRate: string;
  promoted: number;
  tickets: number;
  routingMode: 'shadow' | 'enforce';
  retentionDays: number;
}) {
  return (
    <dl
      aria-label="Signal inbox status"
      className="grid overflow-hidden rounded-xl border border-line bg-line shadow-sm sm:grid-cols-3 sm:gap-px"
    >
      <div className="bg-surface p-4">
        <dt className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Visible in queue
        </dt>
        <dd className="mt-2 font-instrument text-2xl font-semibold tabular-nums">
          {props.visible}
        </dd>
        <dd className="mt-1 text-xs text-ink-muted">Loaded {props.disposition} records</dd>
      </div>
      <div className="bg-surface p-4">
        <dt className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Ticket promotion
        </dt>
        <dd className="mt-2 font-instrument text-2xl font-semibold tabular-nums">
          {props.promotionRate}
        </dd>
        <dd className="mt-1 text-xs text-ink-muted">
          {props.promoted} of {props.tickets} promoted
        </dd>
      </div>
      <div className="bg-surface p-4">
        <dt className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Effective routing
        </dt>
        <dd className="mt-2 text-lg font-semibold capitalize">{props.routingMode}</dd>
        <dd className="mt-1 text-xs text-ink-muted">Retained for {props.retentionDays} days</dd>
      </div>
    </dl>
  );
}
