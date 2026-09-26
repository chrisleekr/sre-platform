import { investigationResultSummary } from '@sre/contracts';
import { investigationRunOutcomeLabel } from '../lib/investigationRuns';
import type { Incident } from '../lib/types';

export function InvestigationResult({
  run,
  compact = false,
}: {
  run: Incident['latestInvestigationRun'];
  compact?: boolean;
}) {
  const summary = run ? investigationResultSummary(run) : null;
  if (!run || !summary) return null;
  const gaps = compact ? [] : (run.gaps ?? []);
  // Count code points so a cut never splits a surrogate pair into a replacement glyph.
  const characters = [...summary];
  return (
    <section
      className="mt-3 rounded-md border border-line p-3"
      aria-label="Latest investigation result"
    >
      <h3 className="text-xs font-semibold text-ink-muted">
        Latest investigation result: {investigationRunOutcomeLabel(run.outcome)}
      </h3>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-secondary">
        {compact && characters.length > 280 ? `${characters.slice(0, 279).join('')}…` : summary}
      </p>
      {gaps.length > 0 && (
        <>
          <h4 className="mt-3 text-xs font-semibold text-ink-muted">Still to verify</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-secondary">
            {gaps.map((gap, index) => (
              <li key={`${index}:${gap}`} className="break-words">
                {gap}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
