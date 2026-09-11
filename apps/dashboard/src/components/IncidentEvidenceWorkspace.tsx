import { formatAbsoluteTime } from '../lib/time';
import type { EvidenceDetail, EvidenceListItem } from '../lib/types';
import { toolDisplayLabel } from '../lib/toolPresentation';
import { IncidentCodeEvidence } from './IncidentCodeEvidence';
import { IncidentTimeSeriesFigure } from './IncidentTimeSeriesFigure';
import { SkeletonBlock, SkeletonRows } from './LoadingSkeleton';

function EvidenceDetailView({ detail }: { detail: EvidenceDetail }) {
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-ink">
            {toolDisplayLabel(detail.tool)}
          </h3>
          <p className="text-xs text-ink-muted">
            Recorded {formatAbsoluteTime(detail.recordedAt)} · {detail.latencyMs} ms
          </p>
        </div>
        {detail.referenceUrl && (
          <a
            href={detail.referenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="break-words text-xs font-semibold text-info underline"
          >
            Open provider reference ↗
          </a>
        )}
      </div>
      {detail.projection.kind === 'code' && <IncidentCodeEvidence projection={detail.projection} />}
      <IncidentTimeSeriesFigure detail={detail} />
      {detail.projection.kind === 'facts' && (
        <div className="max-h-96 overflow-auto rounded-md border border-line">
          <table className="w-full min-w-max text-left text-xs">
            <caption className="sr-only">Human-readable evidence facts</caption>
            <thead className="sticky top-0 bg-surface-subtle">
              <tr>
                {detail.projection.columns.map((column) => (
                  <th key={column} className="px-2 py-2 font-semibold text-ink-secondary">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.projection.rows.length === 0 && (
                <tr className="border-t border-line">
                  <td
                    colSpan={detail.projection.columns.length}
                    className="px-2 py-3 text-ink-muted"
                  >
                    No rows returned.
                  </td>
                </tr>
              )}
              {detail.projection.rows.map((row, index) => (
                <tr key={index} className="border-t border-line">
                  {detail.projection.kind === 'facts' &&
                    detail.projection.columns.map((column) => (
                      <td key={column} className="max-w-80 break-words px-2 py-2 align-top">
                        {String(row[column] ?? '')}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="rounded-md border border-line p-3 text-xs">
        <summary className="cursor-pointer font-semibold text-ink-secondary">Raw evidence</summary>
        <div className="mt-3 space-y-3">
          <div>
            <h4 className="font-semibold text-ink-muted">Input</h4>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-code p-3 text-code-ink">
              {JSON.stringify(detail.input, null, 2)}
            </pre>
          </div>
          <div>
            <h4 className="font-semibold text-ink-muted">Output</h4>
            <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-code p-3 text-code-ink">
              {JSON.stringify(detail.output, null, 2)}
            </pre>
          </div>
        </div>
      </details>
    </div>
  );
}

export function IncidentEvidenceWorkspace({
  evidence,
  details,
  selectedId,
  nextCursor,
  loading,
  error,
  paginationError,
  detailErrors,
  onOpen,
  onLoadOlder,
  onRetry,
}: {
  evidence: EvidenceListItem[];
  details: Record<string, EvidenceDetail | null>;
  selectedId: string | null;
  nextCursor: string | null;
  loading: boolean;
  error: boolean;
  paginationError: boolean;
  detailErrors: Record<string, boolean>;
  onOpen: (id: string) => void;
  onLoadOlder: () => void;
  onRetry: () => void;
}) {
  const selectedDetail = selectedId ? details[selectedId] : undefined;

  return (
    <div id="incident-evidence" className="min-w-0">
      <section
        id={selectedId ? `evidence-${selectedId}` : undefined}
        className="@container min-w-0 rounded-lg border border-line bg-surface p-4"
        aria-labelledby="evidence-title"
      >
        <h2 id="evidence-title" className="font-semibold text-ink">
          Evidence ledger
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          Redacted checks recorded by the investigation.
        </p>
        {loading && evidence.length === 0 ? (
          <div className="mt-3">
            <SkeletonRows label="Loading recorded checks…" rows={4} />
          </div>
        ) : error ? (
          <div
            role="alert"
            className="mt-3 rounded-md border border-critical-line bg-critical-soft p-3 text-sm"
          >
            <p className="font-semibold text-critical">Evidence is unavailable.</p>
            <p className="mt-1 text-critical">The system could not load the evidence ledger.</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 font-semibold text-critical underline"
            >
              Retry evidence
            </button>
          </div>
        ) : evidence.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">No checks recorded yet.</p>
        ) : (
          <div className="mt-3 grid min-w-0 gap-4 @3xl:grid-cols-[18rem_minmax(0,1fr)]">
            <div
              className="min-w-0 max-h-[34rem] space-y-2 overflow-auto"
              aria-label="Evidence records"
            >
              {evidence.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOpen(item.id)}
                  className={`w-full rounded-md border p-3 text-left text-sm ${selectedId === item.id ? 'border-assessment-line bg-assessment-soft' : 'border-line hover:bg-surface-subtle'}`}
                >
                  <span className="block break-words font-medium text-ink">
                    {toolDisplayLabel(item.tool)}
                  </span>
                  <span
                    className={`text-xs ${item.outcome === 'data' ? 'text-success' : 'text-warning'}`}
                  >
                    {item.outcome} · {item.latencyMs} ms
                  </span>
                  <span className="mt-1 block text-xs text-ink-muted">
                    {formatAbsoluteTime(item.recordedAt)}
                  </span>
                </button>
              ))}
            </div>
            <div className="min-w-0 rounded-md border border-line p-3">
              {!selectedId ? (
                <p className="text-sm text-ink-muted">Select a check to inspect its evidence.</p>
              ) : detailErrors[selectedId] ? (
                <div role="alert" className="text-sm text-critical">
                  <p>Evidence detail could not be loaded.</p>
                  <button
                    type="button"
                    onClick={() => onOpen(selectedId)}
                    className="mt-2 font-semibold underline"
                  >
                    Retry detail
                  </button>
                </div>
              ) : selectedDetail === null || selectedDetail === undefined ? (
                <div role="status" aria-live="polite" aria-busy="true" className="space-y-3">
                  <span className="sr-only">Loading evidence detail…</span>
                  <div aria-hidden="true" className="space-y-3">
                    <SkeletonBlock className="h-4 w-44" />
                    <SkeletonBlock className="h-28 w-full" />
                    <SkeletonBlock className="h-4 w-5/6" />
                    <SkeletonBlock className="h-4 w-2/3" />
                  </div>
                </div>
              ) : (
                <div id={`evidence-${selectedDetail.id}`}>
                  <EvidenceDetailView detail={selectedDetail} />
                </div>
              )}
            </div>
          </div>
        )}
        {paginationError && (
          <div
            role="alert"
            className="mt-3 rounded-md border border-warning-line bg-warning-soft p-3 text-sm"
          >
            <p className="font-semibold text-warning">Older evidence is unavailable.</p>
            <button
              type="button"
              onClick={onLoadOlder}
              className="mt-2 font-semibold text-warning underline"
            >
              Retry older evidence
            </button>
          </div>
        )}
        {nextCursor && (
          <button
            type="button"
            onClick={onLoadOlder}
            className="mt-3 min-h-11 text-sm font-medium text-ink-secondary hover:text-ink"
          >
            Load older evidence
          </button>
        )}
      </section>
    </div>
  );
}
