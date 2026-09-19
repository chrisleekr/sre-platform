import { checkResponse, requestErrorMessage } from '../../lib/request-error';
import type { CredentialGetter } from '../../lib/request-credentials';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { config } from '../../config';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { incidentPath } from '../../lib/routes';
import type { IncidentWorkspaceData } from '../../lib/types';

export function IncidentRelationships({
  workspace,
  getCredentials,
  onChanged,
}: {
  workspace: IncidentWorkspaceData;
  getCredentials: CredentialGetter;
  onChanged: () => void;
}) {
  const relations = workspace.relations ?? [];
  const currentId = workspace.incident.id;
  const [rationale, setRationale] = useState('');
  const [evidence, setEvidence] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const isActive = (status: string | undefined) => status === 'open' || status === 'mitigated';
  if (relations.length === 0) return null;
  const causalParent = relations.find(
    (relation) => relation.type === 'caused_by' && relation.sourceIncidentId === currentId,
  );
  const causalChildren = relations.filter(
    (relation) => relation.type === 'caused_by' && relation.targetIncidentId === currentId,
  );
  const mergedPairs = new Set(
    relations
      .filter((relation) => relation.type === 'merged_into')
      .map((relation) => [relation.sourceIncidentId, relation.targetIncidentId].sort().join(':')),
  );

  const correctionBody = (targetIncidentId: string) => ({
    targetIncidentId,
    rationale: rationale.trim(),
    evidence: evidence
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  });

  async function correct(
    action: 'merge' | 'split' | 'unrelated',
    sourceIncidentId: string,
    targetIncidentId: string,
  ) {
    if (!rationale.trim() || !evidence.trim() || pending) return;
    setPending(`${action}:${sourceIncidentId}:${targetIncidentId}`);
    setError('');
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${sourceIncidentId}/${action}`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(correctionBody(targetIncidentId)),
        },
      );
      await checkResponse(response, `Incident ${action} failed.`);
      setRationale('');
      setEvidence('');
      onChanged();
    } catch (cause) {
      setError(requestErrorMessage(cause, `Incident ${action} failed.`));
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      className="@container min-w-0 rounded-lg border border-info-line bg-info-soft p-4"
      aria-labelledby="relations-title"
    >
      <h2 id="relations-title" className="font-medium text-info">
        Incident graph
      </h2>
      <p className="mt-1 text-sm text-info">
        Causal symptoms keep their own evidence and conversation. The response root coordinates the
        shared recovery; timing-only candidates remain separate until evidence establishes
        direction.
      </p>
      {causalParent && (
        <div className="mt-3 rounded-md border border-info-line bg-info-soft p-3 text-sm">
          <p className="font-semibold text-assessment">This incident is a downstream symptom.</p>
          <Link
            className="mt-1 inline-block font-semibold text-assessment underline"
            to={incidentPath(causalParent.targetIncidentId)}
          >
            Open direct cause:{' '}
            {causalParent.targetIncident?.title || causalParent.targetIncidentId.slice(0, 8)}
          </Link>
        </div>
      )}
      {causalChildren.length > 0 && (
        <div className="mt-3 rounded-md border border-info-line bg-surface p-3 text-sm">
          <p className="font-semibold text-ink">Direct symptoms</p>
          <ul className="mt-2 space-y-1 border-l-2 border-info-line pl-3">
            {causalChildren.map((relation) => (
              <li key={relation.id}>
                <Link
                  className="font-semibold text-accent underline"
                  to={incidentPath(relation.sourceIncidentId)}
                >
                  {relation.sourceIncident?.title || relation.sourceIncidentId.slice(0, 8)}
                </Link>{' '}
                <span className="text-ink-muted">downstream symptom</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="mt-3 space-y-2">
        {relations.map((relation) => {
          const otherId =
            relation.sourceIncidentId === currentId
              ? relation.targetIncidentId
              : relation.sourceIncidentId;
          const otherIncident =
            relation.sourceIncidentId === currentId
              ? relation.targetIncident
              : relation.sourceIncident;
          const merged = relation.type === 'merged_into';
          const sourceId = merged ? relation.sourceIncidentId : otherId;
          const targetId = merged ? relation.targetIncidentId : currentId;
          const currentIsActive = isActive(workspace.incident.status);
          const otherIsActive = isActive(otherIncident?.status);
          let mergeSourceId: string | null = null;
          let mergeTargetId: string | null = null;
          if (currentIsActive) {
            mergeSourceId = otherId;
            mergeTargetId = currentId;
          } else if (otherIsActive) {
            mergeSourceId = currentId;
            mergeTargetId = otherId;
          }
          const mergeLabel =
            mergeTargetId === currentId
              ? 'Join into this incident'
              : 'Join this incident into active incident';
          const pairIsMerged = mergedPairs.has(
            [relation.sourceIncidentId, relation.targetIncidentId].sort().join(':'),
          );
          return (
            <li
              key={relation.id}
              className="rounded border border-info-line bg-surface p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-semibold capitalize">
                    {relation.type.replaceAll('_', ' ')}
                  </span>
                  {' · '}
                  <Link className="font-semibold text-accent underline" to={incidentPath(otherId)}>
                    {otherIncident?.title || otherId.slice(0, 8)}
                  </Link>
                </div>
                {merged ? (
                  <button
                    type="button"
                    disabled={!rationale.trim() || !evidence.trim() || pending !== null}
                    onClick={() => void correct('split', sourceId, targetId)}
                    className="rounded border border-info-line px-2.5 py-1 font-medium disabled:opacity-50"
                  >
                    {pending?.startsWith('split:') ? 'Splitting…' : 'Split back out'}
                  </button>
                ) : !pairIsMerged &&
                  (relation.type === 'possible_related' ||
                    relation.type === 'recurrence_of' ||
                    relation.type === 'caused_by') ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={!rationale.trim() || !evidence.trim() || pending !== null}
                      onClick={() =>
                        void correct(
                          'unrelated',
                          relation.sourceIncidentId,
                          relation.targetIncidentId,
                        )
                      }
                      className="rounded border border-info-line px-2.5 py-1 font-medium disabled:opacity-50"
                    >
                      {pending?.startsWith('unrelated:')
                        ? 'Recording…'
                        : relation.type === 'recurrence_of'
                          ? 'Record different cause'
                          : relation.type === 'caused_by'
                            ? 'Reject causal link'
                            : 'Mark unrelated'}
                    </button>
                    {relation.type !== 'caused_by' && mergeSourceId && mergeTargetId && (
                      <button
                        type="button"
                        disabled={!rationale.trim() || !evidence.trim() || pending !== null}
                        onClick={() => void correct('merge', mergeSourceId, mergeTargetId)}
                        className="rounded border border-info-line px-2.5 py-1 font-medium disabled:opacity-50"
                      >
                        {pending?.startsWith('merge:') ? 'Joining…' : mergeLabel}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
              {otherIncident && (
                <>
                  <p className="mt-1 text-xs text-ink-muted">
                    {otherIncident.service} · {otherIncident.severity} · {otherIncident.status} ·{' '}
                    {otherIncident.investigationStatus} · {otherId.slice(0, 8)}
                  </p>
                  {otherIncident.rcaSummary && (
                    <p className="mt-2 rounded bg-surface-subtle p-2 text-xs text-ink-secondary">
                      <span className="font-semibold">
                        Prior recorded assessment, reference only:
                      </span>{' '}
                      {otherIncident.rcaSummary}
                      {otherIncident.confidence !== null && otherIncident.confidence !== undefined
                        ? ` (${otherIncident.confidence}% confidence)`
                        : ''}
                    </p>
                  )}
                </>
              )}
              <p className="mt-1 text-ink-secondary">{relation.rationale}</p>
              <p className="mt-1 text-xs text-ink-muted">
                Decision: {relation.decidedBy}
                {relation.decidedByUserId
                  ? ` · responder ${relation.decidedByUserId.slice(0, 8)}`
                  : ''}
                {relation.correlationFeedback
                  ? relation.correlationFeedback.sharedScopeKeys.length > 0
                    ? ` · future shared scopes: ${relation.correlationFeedback.decision}`
                    : ' · no shared stable scope for future routing'
                  : ''}
                {relation.confidence !== null && relation.confidence !== undefined
                  ? ` · ${relation.confidence}% confidence`
                  : ''}
              </p>
              {relation.evidence.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-ink-muted">
                  {relation.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 grid min-w-0 gap-2 @xl:grid-cols-2">
        <label className="text-sm font-medium">
          Correction reason
          <input
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            maxLength={2_000}
            placeholder="What did the investigation establish?"
            className="mt-1 w-full rounded border border-info-line px-2 py-1.5"
          />
        </label>
        <label className="text-sm font-medium">
          Evidence, one fact per line
          <textarea
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            rows={2}
            placeholder="Same deployment SHA\nShared failing dependency"
            className="mt-1 w-full rounded border border-info-line px-2 py-1.5"
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-critical">
          {error}
        </p>
      )}
    </section>
  );
}
