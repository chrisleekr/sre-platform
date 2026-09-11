export type SignalTone = 'critical' | 'warning' | 'info' | 'success' | 'assessment' | 'unknown';

export interface SignalFacet {
  label: string;
  tone: SignalTone;
}

const TONE_CLASS: Record<SignalTone, string> = {
  critical: 'bg-critical-solid',
  warning: 'bg-warning-solid',
  info: 'bg-info-solid',
  success: 'bg-success-solid',
  assessment: 'bg-assessment-solid',
  unknown: 'bg-line-strong',
};

/** Three labelled operational facets: signal state, evidence state, and responsibility. */
export function SignalSpine({ facets }: { facets: readonly SignalFacet[] }) {
  return (
    <div
      role="img"
      aria-label={facets.map((facet) => facet.label).join('. ')}
      className="flex w-1.5 shrink-0 flex-col gap-0.5 overflow-hidden rounded-full bg-surface-strong"
    >
      {facets.map((facet) => (
        <span
          key={`${facet.label}:${facet.tone}`}
          aria-hidden="true"
          className={`min-h-3 flex-1 ${TONE_CLASS[facet.tone]}`}
        />
      ))}
    </div>
  );
}
