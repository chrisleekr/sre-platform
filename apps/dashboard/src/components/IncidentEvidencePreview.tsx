import type { EvidenceDetail } from '../lib/types';
import { IncidentTimeSeriesFigure } from './IncidentTimeSeriesFigure';

/** Only cached, bounded cited detail is previewed; the ledger never fans out all payloads. */
export function IncidentEvidencePreview({
  detail,
  failed,
}: {
  detail: EvidenceDetail | null | undefined;
  failed?: boolean;
}) {
  if (failed)
    return (
      <span className="mt-2 block text-xs text-warning">Preview unavailable. Open to retry.</span>
    );
  if (!detail)
    return <span className="mt-2 block text-xs text-ink-muted">Loading recorded preview…</span>;
  if (detail.projection.kind === 'time_series')
    return (
      <div className="mt-2">
        <IncidentTimeSeriesFigure detail={detail} compact />
        <span className="mt-1 block text-xs text-ink-muted">
          First metric unit shown. Open for all retained series and data.
        </span>
      </div>
    );
  if (detail.projection.kind === 'facts') {
    const columns = detail.projection.columns.slice(0, 3);
    const rows = detail.projection.rows.slice(0, 2);
    return (
      <span className="mt-2 block rounded bg-surface-subtle p-2 text-xs">
        {rows.length
          ? rows.map((row, index) => (
              <span key={index} className="block break-all">
                {columns.map((column) => `${column}: ${String(row[column] ?? '')}`).join(' · ')}
              </span>
            ))
          : 'No rows returned.'}
        <span className="mt-1 block text-ink-muted">
          Preview of projected facts. Open for details.
        </span>
      </span>
    );
  }
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
  if (log !== null)
    return (
      <span className="mt-2 block whitespace-pre-wrap break-all rounded bg-code p-2 font-instrument text-xs text-code-ink">
        {[...log].slice(0, 280).join('') || 'No log text returned.'}
        {[...log].length > 280 ? '…' : ''}
      </span>
    );
  if (detail.projection.kind === 'code')
    return (
      <span className="mt-2 block text-xs">
        {detail.projection.matches.length} recorded source locations ·{' '}
        {detail.projection.status.replaceAll('_', ' ')}
      </span>
    );
  return (
    <span className="mt-2 block text-xs text-ink-muted">
      Unstructured output. Open to inspect retained content.
    </span>
  );
}
