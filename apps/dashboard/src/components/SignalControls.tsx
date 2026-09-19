import { useState } from 'react';
import { requestErrorMessage } from '../lib/request-error';

export interface SignalPolicy {
  classificationMode: 'shadow' | 'enforce';
  retentionDays: number;
  unsolvedAfterMinutes: number | null;
  secondTeamEnabled: boolean;
  customerVisibleEnabled: boolean;
  enforcementApprovedAt: string | null;
  approvedEvaluationId: string | null;
  approvedCorpusVersion: string | null;
  approvedContractVersion: string | null;
  approvedRuntimeFingerprint: string | null;
}

export interface SignalEvaluation {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  total: number | null;
  correct: number | null;
  criticalSafetyMisses: number | null;
  failureCategory: string | null;
  completedAt: string | null;
  classMetrics: Record<
    'investigate' | 'ticket' | 'log',
    { expected: number; predicted: number; correct: number; recall: number; precision: number }
  > | null;
  scenarioResults: Array<{
    id: string;
    message: string;
    expected: 'investigate' | 'ticket' | 'log';
    expectedTicket: {
      action: string;
      safeDeferralReason: string;
      riskIfIgnored: string;
      reviewHorizonMinutes: number;
    } | null;
    prediction: {
      disposition?: string;
      action?: string;
      safeDeferralReason?: string;
      riskIfIgnored?: string;
      reviewHorizonMinutes?: number;
    } | null;
  }> | null;
}

export interface EnforcementEligibility {
  eligible: boolean;
  reason: string | null;
}

/** Operator controls for retention, declaration criteria, and shadow-to-enforce approval. */
export function SignalPolicyControls(props: {
  policy: SignalPolicy;
  evaluation: SignalEvaluation | null;
  effectiveClassificationMode: 'shadow' | 'enforce';
  enforcementEligibility: EnforcementEligibility;
  onSave: (
    policy: Pick<
      SignalPolicy,
      'retentionDays' | 'unsolvedAfterMinutes' | 'secondTeamEnabled' | 'customerVisibleEnabled'
    >,
  ) => Promise<void>;
  onRunEvaluation: () => Promise<void>;
  onApprove: (evaluationId: string, reviewedTicketScenarioIds: string[]) => Promise<void>;
  onReturnToShadow: () => Promise<void>;
}) {
  const [retentionDays, setRetentionDays] = useState(String(props.policy.retentionDays));
  const [unsolvedMinutes, setUnsolvedMinutes] = useState(
    props.policy.unsolvedAfterMinutes === null ? '' : String(props.policy.unsolvedAfterMinutes),
  );
  const [secondTeam, setSecondTeam] = useState(props.policy.secondTeamEnabled);
  const [customerVisible, setCustomerVisible] = useState(props.policy.customerVisibleEnabled);
  const [pending, setPending] = useState<'save' | 'evaluate' | 'approve' | 'shadow' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewedTicketScenarios, setReviewedTicketScenarios] = useState<Set<string>>(new Set());
  const ticketScenarioResults =
    props.evaluation?.scenarioResults?.filter((result) => result.expected === 'ticket') ?? [];
  const ticketReviewComplete =
    ticketScenarioResults.length > 0 &&
    ticketScenarioResults.every((result) => reviewedTicketScenarios.has(result.id));
  const act = async (
    action: NonNullable<typeof pending>,
    operation: () => Promise<void>,
  ): Promise<void> => {
    setPending(action);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      setError(requestErrorMessage(reason, 'Signal control action failed.'));
    } finally {
      setPending(null);
    }
  };
  const save = () =>
    act('save', () =>
      props.onSave({
        retentionDays: Number(retentionDays),
        unsolvedAfterMinutes: unsolvedMinutes.trim() ? Number(unsolvedMinutes) : null,
        secondTeamEnabled: secondTeam,
        customerVisibleEnabled: customerVisible,
      }),
    );
  return (
    <section
      aria-label="Signal control settings"
      className="rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="font-medium">Signal control settings</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Enforcement requires perfect accuracy across the reviewed shadow corpus, zero
        critical-safety misses, and an explicit operator approval.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Retention days
          <input
            type="number"
            min="1"
            max="3650"
            value={retentionDays}
            onChange={(event) => setRetentionDays(event.target.value)}
            className="sre-field mt-1 min-h-10 w-full"
          />
        </label>
        <label className="text-sm">
          Unsolved review minutes
          <input
            type="number"
            min="1"
            max="10080"
            value={unsolvedMinutes}
            onChange={(event) => setUnsolvedMinutes(event.target.value)}
            className="sre-field mt-1 min-h-10 w-full"
          />
        </label>
      </div>
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <label className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-surface-subtle px-3 py-2">
          <input
            type="checkbox"
            checked={secondTeam}
            onChange={(event) => setSecondTeam(event.target.checked)}
          />
          Second-team criterion
        </label>
        <label className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-surface-subtle px-3 py-2">
          <input
            type="checkbox"
            checked={customerVisible}
            onChange={(event) => setCustomerVisible(event.target.checked)}
          />
          Customer-visible criterion
        </label>
      </div>
      {error && <p className="mt-2 text-sm text-critical">{error}</p>}
      <div className="mt-3 rounded-lg border border-line bg-surface-subtle p-3 text-sm">
        <p className="font-semibold">Classifier evaluation</p>
        {!props.evaluation && (
          <p className="mt-1 text-ink-muted">No runtime evaluation recorded.</p>
        )}
        {props.evaluation && (
          <>
            <p className="mt-1 text-ink-muted" aria-live="polite">
              {props.evaluation.status === 'completed'
                ? `${props.evaluation.correct}/${props.evaluation.total} correct, ${props.evaluation.criticalSafetyMisses} critical-safety misses.`
                : props.evaluation.status === 'failed'
                  ? `Failed: ${props.evaluation.failureCategory ?? 'evaluation_failed'}.`
                  : `Evaluation ${props.evaluation.status}.`}
            </p>
            {props.evaluation.classMetrics && (
              <div className="mt-2 overflow-x-auto">
                <table
                  aria-label="Classifier accuracy by disposition"
                  className="w-full min-w-[28rem]"
                >
                  <thead>
                    <tr>
                      <th scope="col" className="text-left">
                        Disposition
                      </th>
                      <th scope="col" className="text-right">
                        Correct
                      </th>
                      <th scope="col" className="text-right">
                        Recall
                      </th>
                      <th scope="col" className="text-right">
                        Precision
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['investigate', 'ticket', 'log'] as const).map((name) => {
                      const metric = props.evaluation!.classMetrics![name];
                      return (
                        <tr key={name}>
                          <th scope="row" className="text-left capitalize">
                            {name}
                          </th>
                          <td className="text-right">
                            {metric.correct}/{metric.expected}
                          </td>
                          <td className="text-right">{Math.round(metric.recall * 100)}%</td>
                          <td className="text-right">{Math.round(metric.precision * 100)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {ticketScenarioResults.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer font-semibold">
                  Review ticket semantics ({reviewedTicketScenarios.size}/
                  {ticketScenarioResults.length})
                </summary>
                <p className="mt-1 text-ink-muted">
                  Compare every model action, deferral reason, and risk with the human-reviewed
                  reference. Classification accuracy alone cannot approve ticket safety.
                </p>
                <div className="mt-2 space-y-3">
                  {ticketScenarioResults.map((result) => (
                    <label key={result.id} className="block rounded-md border border-line p-3">
                      <span className="flex items-center gap-2 font-semibold">
                        <input
                          type="checkbox"
                          checked={reviewedTicketScenarios.has(result.id)}
                          onChange={(event) => {
                            setReviewedTicketScenarios((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(result.id);
                              else next.delete(result.id);
                              return next;
                            });
                          }}
                        />
                        {result.id}
                      </span>
                      <p className="mt-2 text-sm">
                        <strong>Scenario:</strong> {result.message}
                      </p>
                      <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                        <div>
                          <dt className="font-semibold">Reviewed reference</dt>
                          <dd>Action: {result.expectedTicket?.action}</dd>
                          <dd>Safe deferral: {result.expectedTicket?.safeDeferralReason}</dd>
                          <dd>Risk if ignored: {result.expectedTicket?.riskIfIgnored}</dd>
                          <dd>
                            Review horizon: {result.expectedTicket?.reviewHorizonMinutes} minutes
                          </dd>
                        </div>
                        <div>
                          <dt className="font-semibold">Runtime prediction</dt>
                          <dd>Action: {result.prediction?.action}</dd>
                          <dd>Safe deferral: {result.prediction?.safeDeferralReason}</dd>
                          <dd>Risk if ignored: {result.prediction?.riskIfIgnored}</dd>
                          <dd>Review horizon: {result.prediction?.reviewHorizonMinutes} minutes</dd>
                        </div>
                      </dl>
                    </label>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
        {!props.enforcementEligibility.eligible && props.enforcementEligibility.reason && (
          <p className="mt-1 text-critical">
            Cannot enforce: {props.enforcementEligibility.reason}
          </p>
        )}
        {props.policy.classificationMode === 'enforce' &&
          props.effectiveClassificationMode === 'shadow' && (
            <p className="mt-1 text-critical">
              Enforcement approval is stale for the current runtime or classifier contract. Routing
              remains in shadow mode.
            </p>
          )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void save()}
          className="sre-action sre-hit-target"
        >
          Save settings
        </button>
        <button
          type="button"
          disabled={
            pending !== null ||
            props.evaluation?.status === 'queued' ||
            props.evaluation?.status === 'running'
          }
          onClick={() => void act('evaluate', props.onRunEvaluation)}
          className="sre-action sre-hit-target"
        >
          {pending === 'evaluate' ? 'Starting evaluation…' : 'Run accuracy evaluation'}
        </button>
        {props.policy.classificationMode === 'shadow' ? (
          <button
            type="button"
            disabled={
              pending !== null || !props.enforcementEligibility.eligible || !ticketReviewComplete
            }
            onClick={() =>
              props.evaluation &&
              void act('approve', () =>
                props.onApprove(props.evaluation!.id, [...reviewedTicketScenarios]),
              )
            }
            className="sre-action sre-action-primary sre-hit-target"
          >
            {pending === 'approve' ? 'Approving…' : 'Approve enforcement'}
          </button>
        ) : (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void act('shadow', props.onReturnToShadow)}
            className="sre-action sre-hit-target"
          >
            {pending === 'shadow' ? 'Returning…' : 'Return to shadow'}
          </button>
        )}
      </div>
    </section>
  );
}

/** Human-confirmed declaration criterion and evidence for one ticket promotion. */
export function SignalPromotionControls(props: {
  secondTeamEnabled: boolean;
  customerVisibleEnabled: boolean;
  unsolvedEligible: boolean;
  onPromote: (criterion: string, reason: string) => Promise<void>;
}) {
  const [criterion, setCriterion] = useState(props.unsolvedEligible ? 'unsolved' : 'other');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) return;
        setPending(true);
        setError(null);
        void props
          .onPromote(criterion, reason.trim())
          .catch((failure) =>
            setError(requestErrorMessage(failure, 'Ticket could not be promoted.')),
          )
          .finally(() => setPending(false));
      }}
    >
      <label className="w-full text-sm sm:w-auto">
        Declaration criterion
        <select
          value={criterion}
          onChange={(event) => setCriterion(event.target.value)}
          className="sre-field mt-1 block min-h-10 w-full"
        >
          {props.secondTeamEnabled && <option value="second_team">Needs a second team</option>}
          {props.customerVisibleEnabled && (
            <option value="customer_visible">Customer-visible</option>
          )}
          {props.unsolvedEligible && <option value="unsolved">Unsolved after review</option>}
          <option value="other">Other</option>
        </select>
      </label>
      <label className="min-w-0 flex-1 text-sm sm:min-w-64">
        Evidence
        <input
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="sre-field mt-1 min-h-10 w-full"
          placeholder="Why this now needs incident response"
        />
      </label>
      <button
        type="submit"
        disabled={pending || !reason.trim()}
        className="sre-action sre-action-primary sre-hit-target w-full sm:w-auto"
      >
        Investigate
      </button>
      {error && <p className="w-full text-sm text-critical">{error}</p>}
    </form>
  );
}
