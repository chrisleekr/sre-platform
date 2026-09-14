import { useState } from 'react';

/** Bounded text pages keep long retained output reachable without a nested scroller. */
export function IncidentEvidenceText({ text, label }: { text: string; label: string }) {
  const [page, setPage] = useState(0);
  const size = 6000;
  const count = Math.max(1, Math.ceil(text.length / size));
  const current = Math.min(page, count - 1);
  return (
    <div className="min-w-0">
      <pre
        aria-label={label}
        className="whitespace-pre-wrap break-all rounded bg-code p-3 font-instrument text-xs leading-5 text-code-ink"
      >
        {text.slice(current * size, (current + 1) * size) || 'No text returned.'}
      </pre>
      {count > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <button
            type="button"
            className="min-h-11 underline disabled:opacity-50"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Previous {label} page
          </button>
          <span>
            {label}: {current + 1} / {count} stored text pages
          </span>
          <button
            type="button"
            className="min-h-11 underline disabled:opacity-50"
            disabled={current + 1 === count}
            onClick={() => setPage(current + 1)}
          >
            Next {label} page
          </button>
        </div>
      )}
    </div>
  );
}
