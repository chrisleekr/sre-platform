import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { useFetchResource } from '../lib/useFetchResource';
import { productPath } from '../lib/routes';
import { useKeysetPages } from '../lib/useKeysetPages';
import { PageHeader } from './PageHeader';
import { StatePanel } from './PageState';
import { ReliabilityReportView, type ReliabilityReport } from './ReliabilityReportView';
import {
  PostmortemReportSection,
  RcaCalibrationSection,
  selectPostmortemReport,
  selectRcaCalibrationReport,
} from './ReliabilitySections';
import { SegmentedTabs } from './SegmentedTabs';

const EMPTY = null as ReliabilityReport | null;
const selectReport = (body: unknown) => body as ReliabilityReport;

/** Reliability comparison and weekly reporting workspace. */
export function ReliabilityPanel(props: { mode?: 'dashboard' | 'weekly' } = {}) {
  const { getCredentials } = useSession();
  const [period, setPeriod] = useState<'week' | 'month' | 'quarter'>('week');
  const [serviceCursor, setServiceCursor] = useState<string | undefined>();
  const mode = props.mode ?? 'dashboard';
  const selectedPeriod = mode === 'weekly' ? 'week' : period;
  const basePath =
    mode === 'weekly' ? '/reliability/weekly' : `/reliability?period=${selectedPeriod}`;
  const serviceQuery = serviceCursor
    ? `${basePath.includes('?') ? '&' : '?'}serviceAfter=${encodeURIComponent(serviceCursor)}`
    : '';
  const { data, loading, error } = useFetchResource<ReliabilityReport | null>({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    path: `${basePath}${serviceQuery}`,
    initial: EMPTY,
    select: selectReport,
  });
  // two more reads on the same page; each selector returns null for any other shape,
  // so a stubbed or older API degrades to an "unavailable" line instead of a crash.
  const postmortems = useFetchResource({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    path: '/reliability/postmortems',
    initial: null,
    select: selectPostmortemReport,
  });
  const calibration = useFetchResource({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    path: '/reliability/rca-calibration',
    initial: null,
    select: selectRcaCalibrationReport,
  });
  const servicePage = useMemo(
    () => [...(data?.outages.byService ?? [])],
    [data?.outages.byService],
  );
  const { pages: servicePages, rows: services } = useKeysetPages({
    cursor: serviceCursor,
    page: servicePage,
    loading,
    error,
    enabled: data !== null,
    resetKey: `${mode}:${selectedPeriod}`,
  });
  const shownReport = data ? { ...data, outages: { ...data.outages, byService: services } } : null;
  return (
    <section className="mx-auto w-full max-w-[90rem]">
      <PageHeader
        title={mode === 'weekly' ? 'Weekly reliability report' : 'Reliability'}
        description={
          mode === 'weekly'
            ? 'A shareable weekly view of operational load, signal flow, and responder toil.'
            : 'Compare operational load and human toil across equal elapsed UTC periods.'
        }
        action={
          <Link
            to={productPath(mode === 'weekly' ? 'reliability' : 'reliability/weekly')}
            className="sre-hit-target rounded-md border border-line-strong bg-surface px-3 py-2 text-sm font-semibold text-ink-secondary hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {mode === 'weekly' ? 'Back to reliability' : 'Weekly report'}
          </Link>
        }
      />
      {mode === 'dashboard' && (
        <div className="mb-6 max-w-2xl">
          <SegmentedTabs
            label="Reliability period"
            value={period}
            panelId="reliability-period"
            onChange={(value) => {
              setPeriod(value as typeof period);
              setServiceCursor(undefined);
            }}
            items={[
              { id: 'week', label: 'Week' },
              { id: 'month', label: 'Month' },
              { id: 'quarter', label: 'Quarter' },
            ]}
          />
        </div>
      )}
      <div
        id={mode === 'dashboard' ? 'reliability-period' : undefined}
        role={mode === 'dashboard' ? 'tabpanel' : undefined}
        aria-labelledby={mode === 'dashboard' ? `reliability-period-tab-${period}` : undefined}
        tabIndex={mode === 'dashboard' ? 0 : undefined}
      >
        {loading && servicePages.length === 0 && (
          <StatePanel state="loading" title="Loading reliability report…" skeleton="detail" />
        )}
        {error && <StatePanel state="error" title="Reliability report unavailable." />}
        {!error && shownReport && (
          <>
            <ReliabilityReportView report={shownReport} mode={mode} />
            {data?.outages.byServiceNextCursor && (
              <button
                type="button"
                disabled={loading}
                onClick={() => setServiceCursor(data.outages.byServiceNextCursor ?? undefined)}
                className="mt-3 w-full rounded-md border border-line py-2 text-sm font-medium text-ink-muted hover:bg-surface-subtle"
              >
                Load more services
              </button>
            )}
          </>
        )}
        {loading && servicePages.length > 0 && (
          <p role="status" className="mt-2 text-sm text-ink-muted">
            Loading more services…
          </p>
        )}
        <PostmortemReportSection
          report={selectPostmortemReport(postmortems.data)}
          loading={postmortems.loading}
          error={postmortems.error}
        />
        <RcaCalibrationSection
          report={selectRcaCalibrationReport(calibration.data)}
          loading={calibration.loading}
          error={calibration.error}
        />
      </div>
    </section>
  );
}
