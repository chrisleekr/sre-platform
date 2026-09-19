import { checkResponse, requestErrorMessage } from '../lib/request-error';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { useFetchResource } from '../lib/useFetchResource';
import { useKeysetPages } from '../lib/useKeysetPages';
import { formatAbsoluteTime } from '../lib/time';
import { incidentPath } from '../lib/routes';
import { PageHeader } from './PageHeader';
import { StatePanel } from './PageState';
import { SegmentedTabs } from './SegmentedTabs';
import { SIGNAL_QUEUE_COPY, SignalsOverview } from './SignalsOverview';
import {
  SignalPolicyControls,
  SignalPromotionControls,
  type SignalEvaluation,
  type SignalPolicy,
} from './SignalControls';
import { TagLinkRuleControls, type TagLinkRule } from './TagLinkRuleControls';

interface SignalRow {
  id: string;
  summary: string;
  disposition: 'investigate' | 'ticket' | 'log';
  classificationMode: 'shadow' | 'enforce';
  effectiveDisposition: 'investigate' | 'ticket' | 'log' | null;
  reason: string;
  action: string | null;
  safeDeferralReason: string | null;
  riskIfIgnored: string | null;
  reviewHorizonMinutes: number | null;
  reviewStartedAt: string | null;
  incidentId: string | null;
  actionableTicket: boolean;
  createdAt: string;
}

interface SignalsBody {
  signals: SignalRow[];
  nextCursor: string | null;
  promotion: {
    ticketCount: number;
    promotedCount: number;
    promotionRate: number | null;
    averagePromotionAgeSeconds: number | null;
  };
  policy: SignalPolicy;
  evaluation: SignalEvaluation | null;
  effectiveClassificationMode: 'shadow' | 'enforce';
  enforcementEligibility: { eligible: boolean; reason: string | null };
  tagLinkRules: TagLinkRule[];
}

const EMPTY: SignalsBody = {
  signals: [],
  nextCursor: null,
  promotion: {
    ticketCount: 0,
    promotedCount: 0,
    promotionRate: null,
    averagePromotionAgeSeconds: null,
  },
  policy: {
    classificationMode: 'shadow',
    retentionDays: 30,
    unsolvedAfterMinutes: 60,
    secondTeamEnabled: true,
    customerVisibleEnabled: true,
    enforcementApprovedAt: null,
    approvedEvaluationId: null,
    approvedCorpusVersion: null,
    approvedContractVersion: null,
    approvedRuntimeFingerprint: null,
  },
  evaluation: null,
  effectiveClassificationMode: 'shadow',
  enforcementEligibility: { eligible: false, reason: 'No runtime evaluation has completed.' },
  tagLinkRules: [],
};
const selectBody = (body: unknown) => body as SignalsBody;

/** Signal inbox for deferred tickets and low-noise logged observations. */
export function SignalsPanel() {
  const { getCredentials } = useSession();
  const navigate = useNavigate();
  const [nonce, setNonce] = useState(0);
  const [listRevision, setListRevision] = useState(0);
  const [reviewAction, setReviewAction] = useState<{
    signalId: string;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const [disposition, setDisposition] = useState<'ticket' | 'investigate' | 'log'>('ticket');
  const [cursor, setCursor] = useState<string | undefined>();
  const path = `/signals?disposition=${disposition}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const { data, loading, error } = useFetchResource({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    path,
    initial: EMPTY,
    select: selectBody,
    nonce,
  });
  const signalPage = useMemo(() => data.signals, [data.signals]);
  const { pages, rows: signals } = useKeysetPages({
    cursor,
    page: signalPage,
    loading,
    error,
    enabled: true,
    resetKey: `${disposition}:${listRevision}`,
  });
  useEffect(() => {
    if (data.evaluation?.status !== 'queued' && data.evaluation?.status !== 'running') return;
    const timer = window.setTimeout(() => setNonce((value) => value + 1), 2_000);
    return () => window.clearTimeout(timer);
  }, [data.evaluation?.status, nonce]);
  const request = async (
    requestPath: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ) => {
    const response = await authenticatedFetch(
      `${config.apiBaseUrl}${requestPath}`,
      getCredentials,
      {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    await checkResponse(response, 'Signal action failed. Refresh and retry.');
    setCursor(undefined);
    setListRevision((value) => value + 1);
    setNonce((value) => value + 1);
    return (await response.json().catch(() => null)) as Record<string, unknown> | null;
  };
  const queueCopy = SIGNAL_QUEUE_COPY[disposition];
  const promotionRate =
    data.promotion.promotionRate === null
      ? 'N/A'
      : `${Math.round(data.promotion.promotionRate * 100)}%`;
  return (
    <section className="mx-auto w-full max-w-[90rem]">
      <PageHeader
        title="Signals"
        description="Review actionable tickets and retained context without starting an investigation."
      />
      <div className="space-y-6">
        {!error && pages.length > 0 && (
          <SignalsOverview
            visible={signals.length}
            disposition={disposition}
            promotionRate={promotionRate}
            promoted={data.promotion.promotedCount}
            tickets={data.promotion.ticketCount}
            routingMode={data.effectiveClassificationMode}
            retentionDays={data.policy.retentionDays}
          />
        )}

        <div className="max-w-2xl">
          <SegmentedTabs
            label="Signal disposition"
            value={disposition}
            panelId="signal-list"
            onChange={(value) => {
              setDisposition(value as typeof disposition);
              setCursor(undefined);
            }}
            items={[
              { id: 'ticket', label: 'Tickets' },
              { id: 'investigate', label: 'Investigations' },
              { id: 'log', label: 'Logged context' },
            ]}
          />
        </div>

        <section
          id="signal-list"
          role="tabpanel"
          aria-labelledby={`signal-list-tab-${disposition}`}
          tabIndex={0}
          className="min-w-0"
        >
          {loading && cursor === undefined ? (
            <StatePanel state="loading" title="Loading signals…" skeleton="list" />
          ) : error ? (
            <StatePanel state="error" title="Signals unavailable." />
          ) : (
            <>
              <div className="mb-3">
                <h2 className="text-lg font-medium tracking-tight text-ink">{queueCopy.title}</h2>
                <p className="mt-1 text-sm text-ink-muted">{queueCopy.description}</p>
              </div>
              {signals.length === 0 ? (
                <StatePanel
                  state="empty"
                  title={queueCopy.empty}
                  description={queueCopy.description}
                  announce={false}
                />
              ) : (
                <div className="space-y-3">
                  {signals.map((signal) => (
                    <article
                      key={signal.id}
                      className="rounded-xl border border-line bg-surface p-4 sm:p-5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3
                            className="line-clamp-3 font-medium leading-6 text-ink"
                            title={signal.summary}
                          >
                            {signal.summary}
                          </h3>
                          <p className="mt-1 font-instrument text-xs text-ink-faint">
                            {formatAbsoluteTime(signal.createdAt)}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-assessment-soft px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-assessment">
                          {signal.classificationMode === 'shadow'
                            ? `Shadow proposal: ${signal.disposition}`
                            : (signal.effectiveDisposition ?? signal.disposition)}
                        </span>
                      </div>
                      {signal.classificationMode === 'shadow' && (
                        <p className="mt-3 rounded-lg border border-info-line bg-info-soft px-3 py-2 text-sm text-info">
                          Effective route: {signal.effectiveDisposition ?? 'pending'}. Shadow
                          proposals do not enter operational ticket or log metrics.
                        </p>
                      )}
                      <p className="mt-3 text-sm leading-6 text-ink-muted">{signal.reason}</p>
                      {(signal.action || signal.safeDeferralReason || signal.riskIfIgnored) && (
                        <dl className="mt-4 grid gap-3 rounded-lg bg-surface-subtle p-3 text-sm lg:grid-cols-3">
                          {signal.action && (
                            <div>
                              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                                Action
                              </dt>
                              <dd className="mt-1 leading-5 text-ink-secondary">{signal.action}</dd>
                            </div>
                          )}
                          {signal.safeDeferralReason && (
                            <div>
                              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                                Safe to defer
                              </dt>
                              <dd className="mt-1 leading-5 text-ink-secondary">
                                {signal.safeDeferralReason}
                              </dd>
                            </div>
                          )}
                          {signal.riskIfIgnored && (
                            <div>
                              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                                Risk if ignored
                              </dt>
                              <dd className="mt-1 leading-5 text-ink-secondary">
                                {signal.riskIfIgnored}
                              </dd>
                            </div>
                          )}
                        </dl>
                      )}
                      {signal.reviewHorizonMinutes && (
                        <p className="mt-3 text-xs font-medium text-warning">
                          Review within {signal.reviewHorizonMinutes} minutes.
                        </p>
                      )}
                      {signal.actionableTicket && (
                        <div className="mt-4 border-t border-line pt-4">
                          {!signal.reviewStartedAt && (
                            <>
                              <button
                                type="button"
                                disabled={
                                  reviewAction?.signalId === signal.id && reviewAction.pending
                                }
                                className="sre-action sre-hit-target"
                                onClick={() => {
                                  setReviewAction({
                                    signalId: signal.id,
                                    pending: true,
                                    error: null,
                                  });
                                  void request(`/signals/${signal.id}/review`, 'POST')
                                    .then(() => setReviewAction(null))
                                    .catch((failure) =>
                                      setReviewAction({
                                        signalId: signal.id,
                                        pending: false,
                                        error: requestErrorMessage(
                                          failure,
                                          'Review could not be started.',
                                        ),
                                      }),
                                    );
                                }}
                              >
                                {reviewAction?.signalId === signal.id && reviewAction.pending
                                  ? 'Starting review…'
                                  : 'Start review'}
                              </button>
                              {reviewAction?.signalId === signal.id && reviewAction.error && (
                                <p role="alert" className="mt-2 text-sm text-critical">
                                  {reviewAction.error}
                                </p>
                              )}
                            </>
                          )}
                          <SignalPromotionControls
                            secondTeamEnabled={data.policy.secondTeamEnabled}
                            customerVisibleEnabled={data.policy.customerVisibleEnabled}
                            unsolvedEligible={
                              data.policy.unsolvedAfterMinutes !== null &&
                              signal.reviewStartedAt !== null &&
                              Date.now() >=
                                new Date(signal.reviewStartedAt).getTime() +
                                  data.policy.unsolvedAfterMinutes * 60_000
                            }
                            onPromote={async (criterion, reason) => {
                              const result = await request(
                                `/signals/${signal.id}/promote`,
                                'POST',
                                {
                                  criterion,
                                  reason,
                                },
                              );
                              if (typeof result?.incidentId === 'string')
                                navigate(incidentPath(result.incidentId));
                            }}
                          />
                        </div>
                      )}
                    </article>
                  ))}
                  {data.nextCursor && !loading && (
                    <button
                      type="button"
                      onClick={() => setCursor(data.nextCursor ?? undefined)}
                      className="sre-hit-target w-full rounded-md border border-line-strong bg-surface py-2 text-sm font-semibold text-ink-secondary hover:bg-surface-subtle"
                    >
                      Load more
                    </button>
                  )}
                  {loading && pages.length > 0 && (
                    <p role="status" className="text-sm text-ink-muted">
                      Loading more signals…
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {!error && pages.length > 0 && (
          <details open className="rounded-xl border border-line bg-surface">
            <summary className="cursor-pointer px-4 py-4 font-semibold text-ink sm:px-5">
              Routing and tag settings
            </summary>
            <div className="grid gap-4 border-t border-line p-4 xl:grid-cols-2 sm:p-5">
              <SignalPolicyControls
                key={`${JSON.stringify(data.policy)}:${data.evaluation?.id ?? 'none'}`}
                policy={data.policy}
                evaluation={data.evaluation}
                effectiveClassificationMode={data.effectiveClassificationMode}
                enforcementEligibility={data.enforcementEligibility}
                onSave={async (policy) => {
                  await request('/signals/policy', 'PUT', policy);
                }}
                onRunEvaluation={async () => {
                  await request('/signals/evaluations', 'POST');
                }}
                onApprove={async (evaluationId, reviewedTicketScenarioIds) => {
                  await request('/signals/policy/enforce', 'POST', {
                    evaluationId,
                    reviewedTicketScenarioIds,
                  });
                }}
                onReturnToShadow={async () => {
                  await request('/signals/policy/shadow', 'POST');
                }}
              />
              <TagLinkRuleControls
                rules={data.tagLinkRules}
                onSave={async (rule) => {
                  await request('/signals/tag-link-rules', 'PUT', rule);
                }}
                onRemove={async (prefix) => {
                  await request(`/signals/tag-link-rules/${encodeURIComponent(prefix)}`, 'DELETE');
                }}
              />
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
