import { useContext, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { formatAbsoluteTime } from '../lib/time';
import type { EvidenceDetail, EvidenceListItem } from '../lib/types';
import { evidenceOutcomeLabel, toolDisplayLabel } from '../lib/toolPresentation';
import { IncidentCodeEvidence } from './IncidentCodeEvidence';
import { IncidentTimeSeriesFigure } from './IncidentTimeSeriesFigure';
import { IncidentEvidenceText } from './IncidentEvidenceText';
import { SkeletonRows } from './LoadingSkeleton';
import { SetupDialog } from './SetupDialog';
import { SetupActions, SetupDialogSlots } from './SetupDialogSlots';

function EvidenceScrollPosition({
  selectedId,
  position,
}: {
  selectedId: string | null;
  position: RefObject<number>;
}) {
  const body = useContext(SetupDialogSlots)?.body;
  useLayoutEffect(() => {
    if (!body) return;
    body.scrollTop = selectedId ? 0 : position.current;
    return () => {
      if (!selectedId) position.current = body.scrollTop;
    };
  }, [body, selectedId, position]);
  return null;
}

function EvidenceDetailView({ detail }: { detail: EvidenceDetail }) {
  const [page, setPage] = useState(0);
  const output =
    detail.output && typeof detail.output === 'object' && !Array.isArray(detail.output)
      ? (detail.output as Record<string, unknown>)
      : null;
  const log =
    /^(?:kubernetes_(?:[A-Za-z0-9_-]{22}_)?get_pod_logs|argocd_(?:[A-Za-z0-9_-]{22}_)?get_application_logs)$/.test(
      detail.tool,
    ) && typeof output?.log === 'string'
      ? output.log
      : null;
  return (
    <div className="min-w-0 space-y-3">
      <h3 className="break-words font-medium">{toolDisplayLabel(detail.tool)}</h3>
      {detail.summary && <p className="break-all text-sm">{detail.summary}</p>}
      <p className="text-xs text-ink-muted">
        Recorded {formatAbsoluteTime(detail.recordedAt)} · Execution {detail.latencyMs} ms ·{' '}
        {evidenceOutcomeLabel(detail.outcome)}
      </p>
      {detail.referenceUrl && (
        <a
          href={detail.referenceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center break-all text-accent underline"
        >
          Open provider reference ↗
        </a>
      )}
      {log !== null ? (
        <IncidentEvidenceText key={detail.id} text={log} label="Logs" />
      ) : (
        <>
          {detail.projection.kind === 'code' && (
            <IncidentCodeEvidence projection={detail.projection} />
          )}
          <IncidentTimeSeriesFigure detail={detail} />
          {detail.projection.kind === 'facts' && (
            <>
              <p className="text-xs text-ink-muted">
                Projected facts: up to 50 rows, 12 columns and 240 characters per cell. Stored
                output is available below.
              </p>
              <div className="overflow-x-auto rounded border border-line">
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">Human-readable evidence facts</caption>
                  <thead>
                    <tr>
                      {detail.projection.columns.map((column) => (
                        <th key={column} className="p-2">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.projection.rows.slice(page * 25, (page + 1) * 25).map((row, index) => (
                      <tr key={index} className="border-t border-line">
                        {detail.projection.kind === 'facts' &&
                          detail.projection.columns.map((column) => (
                            <td key={column} className="max-w-80 break-words p-2 align-top">
                              {String(row[column] ?? '')}
                            </td>
                          ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.projection.rows.length === 0 && <p>No rows returned.</p>}
              {detail.projection.rows.length > 25 && (
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    disabled={page === 0}
                    className="min-h-11 underline"
                    onClick={() => setPage(page - 1)}
                  >
                    Previous facts
                  </button>
                  <span className="py-3">Facts page {page + 1}</span>
                  <button
                    type="button"
                    disabled={(page + 1) * 25 >= detail.projection.rows.length}
                    className="min-h-11 underline"
                    onClick={() => setPage(page + 1)}
                  >
                    Next facts
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
      <details className="rounded border border-line p-3">
        <summary className="min-h-11 cursor-pointer font-semibold">Raw evidence</summary>
        <p className="mb-3 text-xs text-ink-muted">
          Stored input/output returned by the API, not the provider's complete history.
        </p>
        <h4 className="mb-2 font-semibold">Input</h4>
        <IncidentEvidenceText
          text={JSON.stringify(detail.input, null, 2) ?? 'null'}
          label="Input"
        />
        <h4 className="my-2 font-semibold">Output</h4>
        <IncidentEvidenceText
          text={JSON.stringify(detail.output, null, 2) ?? 'null'}
          label="Output"
        />
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
  loadingOlder = false,
  open = true,
  onClose,
  onBack,
  returnFocusTo,
  context,
}: {
  evidence: EvidenceListItem[];
  details: Record<string, EvidenceDetail | null>;
  selectedId: string | null;
  nextCursor: string | null;
  loading: boolean;
  error: boolean;
  paginationError: boolean;
  detailErrors: Record<string, boolean>;
  loadingOlder?: boolean;
  onOpen: (id: string) => void;
  onLoadOlder: () => void;
  onRetry: () => void;
  open?: boolean;
  onClose?: () => void;
  onBack?: () => void;
  returnFocusTo?: HTMLElement | null;
  context?: string | null;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(0);
  const listPosition = useRef(0);
  const filtered = evidence.filter(
    (item) =>
      (!source || toolDisplayLabel(item.tool).split(' · ')[0] === source) &&
      (!outcome || item.outcome === outcome) &&
      `${item.summary ?? ''} ${toolDisplayLabel(item.tool)} ${item.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 20) - 1));
  if (!open) return null;
  const content = (
    <section className="min-w-0 space-y-3" aria-label="Evidence ledger">
      {selectedId ? (
        <div id={`evidence-${selectedId}`}>
          {detailErrors[selectedId] ? (
            <div role="alert">
              <p>Evidence detail could not be loaded.</p>
              <button
                type="button"
                className="min-h-11 underline"
                onClick={() => onOpen(selectedId)}
              >
                Retry detail
              </button>
            </div>
          ) : details[selectedId] ? (
            <EvidenceDetailView key={selectedId} detail={details[selectedId]} />
          ) : (
            <SkeletonRows label="Loading evidence detail…" rows={4} />
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-ink-muted">
            {evidence.length} loaded records{nextCursor ? ' · Older records available' : ''}.
            Filters apply to loaded records only.
          </p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <label className="min-w-0 text-xs">
              Search loaded evidence
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                className="sre-field mt-1 min-h-11 w-full min-w-0 p-2"
              />
            </label>
            <label className="min-w-0 text-xs">
              Source
              <select
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setPage(0);
                }}
                className="sre-field mt-1 min-h-11 w-full min-w-0 p-2"
              >
                <option value="">All sources</option>
                {[
                  ...new Set(evidence.map((item) => toolDisplayLabel(item.tool).split(' · ')[0])),
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="min-w-0 text-xs">
              Outcome
              <select
                value={outcome}
                onChange={(event) => {
                  setOutcome(event.target.value);
                  setPage(0);
                }}
                className="sre-field mt-1 min-h-11 w-full min-w-0 p-2"
              >
                <option value="">All outcomes</option>
                {[...new Set(evidence.map((item) => item.outcome))].map((value) => (
                  <option key={value} value={value}>
                    {evidenceOutcomeLabel(value)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {loading && evidence.length === 0 && (
            <SkeletonRows label="Loading recorded checks…" rows={4} />
          )}
          {error && (
            <div role="alert">
              <p>Evidence is unavailable. Previously loaded records remain available.</p>
              <button className="min-h-11 underline" onClick={onRetry}>
                Retry evidence
              </button>
            </div>
          )}
          {!loading && !error && evidence.length === 0 && <p>No checks recorded yet.</p>}
          {evidence.length > 0 && filtered.length === 0 && (
            <p>No loaded records match these filters. Clear filters or load older evidence.</p>
          )}
          <div aria-label="Evidence records" className="space-y-2">
            {filtered.slice(currentPage * 20, (currentPage + 1) * 20).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(item.id)}
                className="min-h-11 w-full rounded border border-line p-3 text-left hover:bg-surface-subtle"
              >
                <span className="block break-words font-semibold">
                  {toolDisplayLabel(item.tool)}
                </span>
                <span className="my-1 block break-all text-sm">
                  {item.summary || `Check ${item.id.slice(0, 8)}`}
                </span>
                <span className="text-xs text-ink-muted">
                  {evidenceOutcomeLabel(item.outcome)} · {formatAbsoluteTime(item.recordedAt)}
                </span>
              </button>
            ))}
          </div>
          {filtered.length > 0 && (
            <p className="text-xs">
              Showing {currentPage * 20 + 1}-{Math.min((currentPage + 1) * 20, filtered.length)} of{' '}
              {filtered.length} matching loaded records
            </p>
          )}
          {filtered.length > 20 && (
            <div className="flex gap-3">
              <button
                type="button"
                className="min-h-11 underline"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous records
              </button>
              <button
                type="button"
                className="min-h-11 underline"
                disabled={(currentPage + 1) * 20 >= filtered.length}
                onClick={() => setPage(currentPage + 1)}
              >
                Next records
              </button>
            </div>
          )}
          {paginationError && (
            <p role="alert">Older evidence is unavailable. Retry without losing loaded records.</p>
          )}
          {nextCursor && (
            <button
              type="button"
              disabled={loadingOlder}
              onClick={onLoadOlder}
              className="min-h-11 underline"
            >
              {loadingOlder
                ? 'Loading older evidence…'
                : paginationError
                  ? 'Retry older evidence'
                  : 'Load older evidence'}
            </button>
          )}
        </>
      )}
    </section>
  );
  return onClose ? (
    <SetupDialog
      title="Evidence ledger"
      closeLabel="Close"
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    >
      <EvidenceScrollPosition selectedId={selectedId} position={listPosition} />
      {selectedId && context && (
        <section
          className="mb-4 rounded border border-assessment-line bg-assessment-soft p-3 text-sm"
          aria-label="Originating claim"
        >
          <h3 className="font-medium text-assessment">Opened from this assessment</h3>
          <p className="mt-1 whitespace-pre-wrap break-words">
            {[...context].slice(0, 600).join('')}
            {[...context].length > 600 ? '…' : ''}
          </p>
        </section>
      )}
      {content}
      {selectedId && (
        <SetupActions>
          <button type="button" onClick={onBack} className="sre-action min-h-11">
            Back to evidence
          </button>
        </SetupActions>
      )}
    </SetupDialog>
  ) : (
    content
  );
}
