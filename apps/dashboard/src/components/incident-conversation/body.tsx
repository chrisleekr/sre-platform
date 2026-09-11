import { MAX_CONTENT_CHARS } from '@sre/contracts';
import { Link } from 'react-router-dom';
import { incidentPath } from '../../lib/routes';
import { IncidentEvidenceWorkspace } from '../IncidentEvidenceWorkspace';
import { CodeContextPanel } from './code-context';
import { EntityContextPanel } from './entity-context';
import { IncidentRelationships } from './relationships';
import { SignalOverview } from './signals';
import { ConversationLog, deliveryLabel } from './timeline';
import type { IncidentLiveViewModel } from './view-model';

export function IncidentBody({ view }: { view: IncidentLiveViewModel }) {
  const {
    workspace,
    viewerName,
    getCredentials,
    refreshWorkspace,
    incident,
    stream,
    history,
    evidenceState,
    attachments,
    attachmentDeps,
    draft,
    setDraft,
    zoom,
    setZoom,
    fullAudit,
    setFullAudit,
    confirmingRepositoryId,
    repositoryConfirmError,
    selectedEvidenceId,
    canPost,
    sentDelivery,
    hasSlackBinding,
    openEvidence,
    submit,
    confirmRepository,
    decide,
    mergedTargetId,
    recoveryIsCurrent,
  } = view;
  return (
    <>
      <div className="grid min-w-0 gap-4 @4xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.9fr)] @4xl:items-start">
        <section className="min-w-0" aria-labelledby="timeline-title">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="timeline-title" className="font-semibold text-ink">
                Incident conversation
              </h2>
              <p className="text-xs text-ink-muted">
                Slack and dashboard share this durable record.
              </p>
            </div>
            <div
              className="flex rounded-md border border-line-strong bg-surface p-1"
              aria-label="Timeline view"
            >
              <button
                type="button"
                aria-pressed={!fullAudit}
                onClick={() => setFullAudit(false)}
                className={`min-h-9 rounded px-3 text-xs font-medium ${!fullAudit ? 'bg-strong text-on-strong' : 'text-ink-muted'}`}
              >
                Key events
              </button>
              <button
                type="button"
                aria-pressed={fullAudit}
                onClick={() => setFullAudit(true)}
                className={`min-h-9 rounded px-3 text-xs font-medium ${fullAudit ? 'bg-strong text-on-strong' : 'text-ink-muted'}`}
              >
                Full audit
              </button>
            </div>
          </div>
          {history.hasOlder && (
            <button
              type="button"
              onClick={history.loadOlder}
              disabled={history.loadingOlder}
              className="mb-3 min-h-11 text-sm font-medium text-ink-secondary disabled:opacity-50"
            >
              {history.loadingOlder ? 'Loading…' : 'Load older history'}
            </button>
          )}
          {history.error && (
            <div role="alert" className="mb-3 text-sm text-critical">
              <p>{history.error}</p>
              <button
                type="button"
                onClick={history.retry}
                disabled={history.loadingOlder}
                className="min-h-11 underline"
              >
                Retry history
              </button>
            </div>
          )}
          {view.attachmentState.error && (
            <div role="alert" className="mb-3 text-sm text-critical">
              <p>{view.attachmentState.error}</p>
              <button
                type="button"
                onClick={view.attachmentState.retry}
                className="min-h-11 underline"
              >
                Retry attachments
              </button>
            </div>
          )}
          <ConversationLog
            messages={history.messages}
            attachments={attachments}
            attachmentDeps={attachmentDeps}
            onZoom={setZoom}
            onDecide={decide}
            viewerUserId={workspace.viewerUserId}
            viewerName={viewerName}
            fullAudit={fullAudit}
            representedFindings={[
              incident.rcaSummary ?? '',
              recoveryIsCurrent ? (incident.recoverySummary ?? '') : '',
            ]}
            workspace={workspace}
            getCredentials={getCredentials}
            onFeedbackChanged={refreshWorkspace}
          />
          {/* A refused post is per-message; the conversation remains open. */}
          {view.decisionError && (
            <p role="alert" className="mt-3 text-xs text-critical">
              {view.decisionError}
            </p>
          )}
          {stream.error && (
            <p role="alert" className="mt-3 text-xs text-critical">
              {stream.error}
            </p>
          )}
          {stream.connectionError && (
            <div
              role="alert"
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-critical-line bg-critical-soft px-3 py-2 text-xs text-critical"
            >
              <p>{stream.connectionError}</p>
              <button
                type="button"
                onClick={stream.retry}
                className="min-h-11 rounded border border-critical-line bg-surface px-3 py-2 font-medium hover:bg-critical-muted"
              >
                Reconnect
              </button>
            </div>
          )}
          <div className="mt-4 min-w-0 rounded-xl border border-line-strong bg-surface p-3">
            {!mergedTargetId && incident.latestInvestigationRun?.outcome === 'failed' && (
              <div className="mb-3 text-sm text-ink-secondary">
                {incident.pendingAutomation ? (
                  <p>
                    An investigation is already queued or running. See Next automation for its
                    schedule.
                  </p>
                ) : (
                  <>
                    <p>The last investigation failed. No automatic retry remains.</p>
                    <button
                      type="button"
                      disabled={!canPost || !!draft.trim()}
                      className="mt-2 min-h-11 rounded-lg border border-line-strong px-3 py-2 font-semibold disabled:opacity-50"
                      onClick={() => {
                        setDraft(
                          'Please retry the investigation and check whether the previous blocker has cleared.',
                        );
                        document.getElementById('incident-composer')?.focus();
                      }}
                    >
                      Prepare retry request
                    </button>
                    <p className="mt-1 text-xs">
                      Review the message below, then Send to request another investigation.
                    </p>
                  </>
                )}
              </div>
            )}
            <label
              htmlFor="incident-composer"
              className="mb-1 block text-xs font-semibold text-ink-secondary"
            >
              {mergedTargetId ? 'Continue in the joined incident' : 'Ask the SRE'}
            </label>
            {mergedTargetId && (
              <p className="mb-2 text-sm text-info">
                <Link className="font-semibold underline" to={incidentPath(mergedTargetId)}>
                  Open the active incident
                </Link>{' '}
                to continue the investigation.
              </p>
            )}
            <div className="grid min-w-0 gap-2">
              <textarea
                id="incident-composer"
                rows={3}
                className="max-h-64 min-h-24 w-full min-w-0 resize-y rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm disabled:bg-surface-strong"
                aria-describedby="incident-composer-status"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                maxLength={MAX_CONTENT_CHARS}
                placeholder={
                  mergedTargetId
                    ? 'This incident was joined into another investigation'
                    : 'Ask for evidence, challenge a hypothesis, or request the next check'
                }
                disabled={!canPost}
              />
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
              <p
                id="incident-composer-status"
                className="min-w-0 flex-1 text-xs text-ink-muted"
                aria-live="polite"
              >
                {stream.postState?.state === 'saving'
                  ? 'Saving to the incident…'
                  : stream.postState?.state === 'failed'
                    ? 'The message was not saved. Retry when the stream is available.'
                    : stream.postState?.state === 'saved'
                      ? (deliveryLabel(sentDelivery) ??
                        (hasSlackBinding
                          ? 'Saved to the incident. Waiting for Slack acceptance.'
                          : 'Saved to the incident. Investigation is continuing.'))
                      : 'Enter sends. Shift+Enter adds a new line.'}
              </p>
              <button
                type="button"
                onClick={submit}
                disabled={!canPost || !draft.trim()}
                className="min-h-11 shrink-0 rounded-lg bg-strong px-4 py-2 text-sm text-on-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {stream.postState?.state === 'saving' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </section>
        <aside
          aria-label="Incident evidence and context"
          className="min-w-0 space-y-4 @4xl:sticky @4xl:top-4 @4xl:max-h-[calc(100dvh-7rem)] @4xl:overflow-y-auto @4xl:pr-1"
        >
          <IncidentEvidenceWorkspace
            evidence={evidenceState.evidence}
            details={evidenceState.details}
            selectedId={selectedEvidenceId}
            nextCursor={evidenceState.nextCursor}
            loading={evidenceState.loading}
            error={evidenceState.error}
            paginationError={evidenceState.paginationError}
            detailErrors={evidenceState.detailErrors}
            onOpen={openEvidence}
            onLoadOlder={evidenceState.loadOlder}
            onRetry={evidenceState.refresh}
          />
          <EntityContextPanel
            workspace={workspace}
            getCredentials={getCredentials}
            onChanged={refreshWorkspace}
          />
          <CodeContextPanel
            workspace={workspace}
            confirmingRepositoryId={confirmingRepositoryId}
            confirmError={repositoryConfirmError}
            onConfirm={(provider, dataSourceId, repositoryId, serviceName, path) =>
              void confirmRepository(provider, dataSourceId, repositoryId, serviceName, path)
            }
          />
          <IncidentRelationships
            workspace={workspace}
            getCredentials={getCredentials}
            onChanged={refreshWorkspace}
          />
          <SignalOverview
            workspace={workspace}
            getCredentials={getCredentials}
            onChanged={refreshWorkspace}
          />
        </aside>
      </div>
      {zoom && (
        <SetupDialog title="Zoomed screenshot" closeLabel="Close" onClose={() => setZoom(null)}>
          <img
            src={zoom}
            alt="Zoomed screenshot"
            className="mx-auto max-h-[70dvh] max-w-full object-contain"
          />
        </SetupDialog>
      )}
    </>
  );
}
import { SetupDialog } from '../SetupDialog';
