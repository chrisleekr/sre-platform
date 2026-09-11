import type { PostmortemReport, RcaCalibrationReport } from '@sre/contracts';
import { Link } from 'react-router-dom';
import { postmortemPath } from '../lib/routes';

const EYEBROW =
  'font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-accent';
const HEADING = 'mt-1 text-lg font-semibold tracking-tight';
const NOTE =
  'rounded-lg border border-warning-line bg-warning-soft px-4 py-3 text-sm leading-6 text-warning';
const CELL = 'py-1 pr-3';

const percent = (rate: number | null): string =>
  rate === null ? '—' : `${Math.round(rate * 100)}%`;

/** Narrows a report body to a PostmortemReport; null for any other shape (a stub, an older API). */
export function selectPostmortemReport(body: unknown): PostmortemReport | null {
  const candidate = body as Partial<PostmortemReport> | null;
  return candidate &&
    typeof candidate === 'object' &&
    candidate.actionItems &&
    candidate.postmortems
    ? (candidate as PostmortemReport)
    : null;
}

/** Narrows a report body to an RcaCalibrationReport; only `verdict` is required. */
export function selectRcaCalibrationReport(body: unknown): RcaCalibrationReport | null {
  const candidate = body as Partial<RcaCalibrationReport> | null;
  return candidate && typeof candidate === 'object' && typeof candidate.verdict === 'string'
    ? (candidate as RcaCalibrationReport)
    : null;
}

const ageLabel = (bucket: { lowerDays: number; upperDays: number | null }): string =>
  bucket.upperDays === null
    ? `${bucket.lowerDays}+ days`
    : `${bucket.lowerDays}–${bucket.upperDays} days`;

/** Postmortem and action item follow-through (Google SRE Ch 15): untracked and past-due are defects. */
export function PostmortemReportSection({
  report,
  loading,
  error,
}: {
  report: PostmortemReport | null;
  loading: boolean;
  error: boolean;
}) {
  return (
    <section aria-label="Postmortem action items" className="mt-8">
      <p className={EYEBROW}>Postmortems</p>
      <h2 className={HEADING}>Postmortem action items</h2>
      {loading && !report && <p className="text-sm text-ink-muted">Loading postmortem report…</p>}
      {(error || (!loading && !report)) && (
        <p className="text-sm text-ink-muted">Postmortem report unavailable.</p>
      )}
      {report && (
        <div className="mt-3 space-y-3 text-sm">
          <p>
            {report.postmortems.draft} draft · {report.postmortems.published} published ·{' '}
            {report.actionItems.open} open action items
          </p>
          {report.actionItems.untracked > 0 && (
            <p className={NOTE}>
              {report.actionItems.untracked} open action{' '}
              {report.actionItems.untracked === 1 ? 'item is' : 'items are'} untracked (no owner or
              no tracker link).
            </p>
          )}
          <table className="text-sm">
            <caption className="sr-only">Open action items by age</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className={CELL}>Age</th>
                <th className={CELL}>Open</th>
              </tr>
            </thead>
            <tbody>
              {(report.actionItems.openByAge ?? []).map((bucket) => (
                <tr key={bucket.label}>
                  <td className={CELL}>{ageLabel(bucket)}</td>
                  <td className={CELL}>{bucket.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.actionItems.pastDue > 0 && (
            <div>
              <p className="font-semibold">{report.actionItems.pastDue} past due</p>
              <ul className="mt-1 list-disc pl-5">
                {(report.postmortemsWithPastDueItems ?? []).map((row) => (
                  <li key={row.postmortemId}>
                    <Link to={postmortemPath(row.incidentId)} className="underline">
                      Postmortem {row.postmortemId.slice(0, 8)}
                    </Link>{' '}
                    · {row.pastDue} past due
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * RCA calibration: whether claimed confidence predicts graded accuracy. Below the reporting
 * floor the section says so in prose; a chart over a handful of grades would be a number pretending
 * to be a measurement.
 */
export function RcaCalibrationSection({
  report,
  loading,
  error,
}: {
  report: RcaCalibrationReport | null;
  loading: boolean;
  error: boolean;
}) {
  return (
    <section aria-label="RCA calibration" className="mt-8">
      <p className={EYEBROW}>Root-cause assessments</p>
      <h2 className={HEADING}>RCA calibration</h2>
      {loading && !report && <p className="text-sm text-ink-muted">Loading calibration…</p>}
      {(error || (!loading && !report)) && (
        <p className="text-sm text-ink-muted">Calibration report unavailable.</p>
      )}
      {report?.verdict === 'insufficient_data' && (
        <p className={`${NOTE} mt-3`}>
          Not enough graded assessments to say whether claimed confidence predicts accuracy
          {report.floor ? ` (fewer than ${report.floor} graded per confidence bucket)` : ''}.
          Publish postmortems and grade their assessments to build the sample.
        </p>
      )}
      {report && report.verdict !== 'insufficient_data' && (
        <div className="mt-3 space-y-3 text-sm">
          <p className={report.verdict === 'uninformative' ? NOTE : undefined}>
            {report.verdict === 'informative'
              ? 'Claimed confidence is informative: higher claims are more often right.'
              : 'Claimed confidence is uninformative: accuracy does not rise with the claim.'}{' '}
            Overall accuracy {percent(report.overall?.accuracy ?? null)} over{' '}
            {report.overall?.graded ?? 0} graded.
          </p>
          <table className="text-sm">
            <caption className="sr-only">Accuracy by claimed confidence</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className={CELL}>Claimed confidence</th>
                <th className={CELL}>Graded</th>
                <th className={CELL}>Observed accuracy</th>
                <th className={CELL}>Claimed mean</th>
              </tr>
            </thead>
            <tbody>
              {(report.byConfidenceBucket ?? []).map((bucket) => (
                <tr key={`${bucket.lower}-${bucket.upper}`}>
                  <td className={CELL}>
                    {bucket.lower}–{Math.min(bucket.upper, 100)}
                  </td>
                  <td className={CELL}>{bucket.graded}</td>
                  <td className={CELL}>
                    {bucket.observedAccuracy === null
                      ? 'below floor'
                      : percent(bucket.observedAccuracy)}
                  </td>
                  <td className={CELL}>
                    {bucket.claimedMean === null ? '—' : bucket.claimedMean.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Runbook cited: {percent(report.runbookAdoption?.cited.accuracy ?? null)} accuracy over{' '}
            {report.runbookAdoption?.cited.graded ?? 0} graded · uncited:{' '}
            {percent(report.runbookAdoption?.uncited.accuracy ?? null)} over{' '}
            {report.runbookAdoption?.uncited.graded ?? 0} graded.
          </p>
          <p>
            Judge agreement: {percent(report.judgeAgreement?.rate ?? null)} of{' '}
            {report.judgeAgreement?.bothGraded ?? 0} assessments graded by both a responder and the
            model.
          </p>
        </div>
      )}
    </section>
  );
}
