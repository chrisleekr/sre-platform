import type { CredentialGetter } from '../../lib/request-credentials';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { config } from '../../config';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { checkResponse, RequestError, requestErrorMessage } from '../../lib/request-error';
import { useIncidentApproval } from '../../lib/useIncidentApproval';
import { assessmentLabel } from '../../lib/incidentState';
import type { PostmortemTrigger } from '@sre/contracts';
import { postmortemPath, productPath } from '../../lib/routes';
import { formatAbsoluteTime } from '../../lib/time';
import type { IncidentWorkspaceData } from '../../lib/types';
import { useAttachments } from '../../lib/useAttachments';
import { useIncidentEvidence } from '../../lib/useIncidentEvidence';
import { useIncidentHistory } from '../../lib/useIncidentHistory';
import { useWsStream } from '../../lib/useWsStream';
import { type AttachmentDeps } from '../MessageAttachments';

import { type LifecycleStatus } from './signals';
import { deriveIncidentState } from './state';
import { IncidentLiveView } from './view';
import type { IncidentLiveViewModel } from './view-model';

export function LiveIncidentConversation({
  workspace,
  viewerName,
  getCredentials,
  refreshWorkspace,
}: {
  workspace: IncidentWorkspaceData;
  viewerName?: string;
  getCredentials: CredentialGetter;
  refreshWorkspace: () => void;
}) {
  const navigate = useNavigate();
  const incident = workspace.incident;
  const assessment = assessmentLabel(incident);
  const stream = useWsStream(incident.id, {
    apiBaseUrl: config.apiBaseUrl,
    wsBaseUrl: config.wsBaseUrl,
    getCredentials,
  });
  const history = useIncidentHistory(incident.id, stream.messages, {
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });
  const evidenceState = useIncidentEvidence(incident.id, {
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });
  const attachmentState = useAttachments(incident.id, {
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });
  const [draft, setDraft] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);
  const [fullAudit, setFullAudit] = useState(false);
  const [lifecycleReason, setLifecycleReason] = useState('');
  const [lifecyclePending, setLifecyclePending] = useState<LifecycleStatus | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [postmortemTrigger, setPostmortemTrigger] = useState<PostmortemTrigger | ''>('');
  const [postmortemPending, setPostmortemPending] = useState(false);
  const [postmortemError, setPostmortemError] = useState<string | null>(null);
  const [signalCorrectionOpen, setSignalCorrectionOpen] = useState(false);
  const [signalCorrectionTarget, setSignalCorrectionTarget] = useState<{
    id: string;
    expectedVersion: number;
  } | null>(null);
  const [signalCorrectionReason, setSignalCorrectionReason] = useState('');
  const [signalCorrectionPending, setSignalCorrectionPending] = useState(false);
  const [signalCorrectionError, setSignalCorrectionError] = useState<string | null>(null);
  const [archiveConfirmation, setArchiveConfirmation] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [confirmingRepositoryId, setConfirmingRepositoryId] = useState<string | null>(null);
  const [repositoryConfirmError, setRepositoryConfirmError] = useState<string | null>(null);
  const { error: decisionError, decide } = useIncidentApproval(
    config.apiBaseUrl,
    getCredentials,
    incident.id,
  );
  const [copyLinkState, setCopyLinkState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [manualEvidenceSelection, setManualEvidenceSelection] = useState<{
    incidentId: string;
    evidenceId: string;
  } | null>(null);
  const {
    activeSignalCount,
    activeSignals,
    allSignalsCleared,
    mergedTargetId,
    needsHuman,
    ownershipLabel,
    ownershipMarker,
    providerState,
    recoveryIsCurrent,
    signals,
  } = deriveIncidentState(workspace);
  const canPost =
    !mergedTargetId && stream.status === 'open' && stream.postState?.state !== 'saving';
  const createdAt = formatAbsoluteTime(incident.createdAt);
  const selectedSignal = signalCorrectionTarget
    ? (activeSignals.find((signal) => signal.id === signalCorrectionTarget.id) ?? null)
    : null;
  const signalCorrectionStale =
    signalCorrectionTarget !== null &&
    (selectedSignal === null || selectedSignal.version !== signalCorrectionTarget.expectedVersion);
  const openEvidence = useCallback(
    (evidenceId: string) => {
      setSelectedEvidenceId(evidenceId);
      setManualEvidenceSelection({ incidentId: incident.id, evidenceId });
      evidenceState.loadDetail(evidenceId);
      requestAnimationFrame(() => {
        document.getElementById(`evidence-${evidenceId}`)?.scrollIntoView?.({ block: 'start' });
      });
    },
    [evidenceState.loadDetail, incident.id],
  );

  useEffect(() => {
    if (manualEvidenceSelection?.incidentId === incident.id) return;
    const first = recoveryIsCurrent
      ? (incident.recoveryEvidenceIds?.[0] ?? evidenceState.evidence[0]?.id)
      : (incident.assessmentEvidenceIds?.[0] ?? evidenceState.evidence[0]?.id);
    if (first && first !== selectedEvidenceId) {
      setSelectedEvidenceId(first);
      evidenceState.loadDetail(first);
    }
  }, [
    evidenceState.evidence,
    evidenceState.loadDetail,
    incident.assessmentEvidenceIds,
    incident.assessmentUpdatedAt,
    incident.recoveryEvidenceIds,
    incident.recoveryState,
    incident.recoveryUpdatedAt,
    manualEvidenceSelection,
    recoveryIsCurrent,
    selectedEvidenceId,
  ]);

  async function copyIncidentLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyLinkState('copied');
    } catch {
      setCopyLinkState('failed');
    }
  }

  const newest = stream.messages.at(-1);
  useEffect(() => {
    if (!newest) return;
    history.refresh();
    if (
      newest.kind === 'tool_step' ||
      newest.kind === 'finding' ||
      newest.kind === 'reply' ||
      newest.kind === 'lifecycle' ||
      newest.kind === 'signal' ||
      newest.kind === 'relationship' ||
      newest.kind === 'archive'
    ) {
      evidenceState.refresh();
      refreshWorkspace();
    }
  }, [newest?.id]);

  const sentMessage = stream.postState?.messageId
    ? history.messages.find((message) => message.id === stream.postState!.messageId)
    : undefined;
  const sentDelivery = sentMessage?.slackDelivery;
  const hasSlackBinding = incident.originSurface === 'slack' && Boolean(incident.originThreadId);
  useEffect(() => {
    if (!stream.postState?.messageId) return;
    if (!hasSlackBinding && !sentDelivery) return;
    if (sentDelivery && !['queued', 'sending'].includes(sentDelivery.state)) return;
    const timer = setInterval(history.refresh, 1_000);
    return () => clearInterval(timer);
  }, [hasSlackBinding, sentDelivery?.state, stream.postState?.messageId]);

  const attachmentDeps: AttachmentDeps = {
    incidentId: incident.id,
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  };

  function submit() {
    const text = draft.trim();
    if (!text || !canPost) return;
    if (stream.send(text)) setDraft('');
  }

  async function transitionLifecycle(to: LifecycleStatus) {
    const reason = lifecycleReason.trim();
    if (!reason || lifecyclePending) return;
    setLifecyclePending(to);
    setLifecycleError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${incident.id}/lifecycle`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            to,
            reason,
            requestId: crypto.randomUUID(),
            expectedVersion: incident.lifecycleVersion,
          }),
        },
      );
      if (!response.ok) {
        if (response.status === 409) refreshWorkspace();
        await checkResponse(
          response,
          response.status === 409
            ? 'Incident state changed. Review it and try again.'
            : 'Lifecycle change failed.',
        );
      }
      setLifecycleReason('');
      refreshWorkspace();
    } catch (error) {
      setLifecycleError(requestErrorMessage(error, 'Lifecycle change failed.'));
    } finally {
      setLifecyclePending(null);
    }
  }

  // a 202 means the draft job is queued; the postmortem page polls until it exists.
  async function generatePostmortem() {
    if (!postmortemTrigger || postmortemPending) return;
    setPostmortemPending(true);
    setPostmortemError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${incident.id}/postmortem/generate`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trigger: postmortemTrigger }),
        },
      );
      await checkResponse(response, 'Postmortem generation could not be started.');
      navigate(postmortemPath(incident.id));
    } catch (error) {
      setPostmortemError(requestErrorMessage(error, 'Postmortem generation could not be started.'));
    } finally {
      setPostmortemPending(false);
    }
  }

  async function correctSignal() {
    const reason = signalCorrectionReason.trim();
    if (
      !selectedSignal ||
      !signalCorrectionTarget ||
      signalCorrectionStale ||
      !reason ||
      signalCorrectionPending
    )
      return;
    setSignalCorrectionPending(true);
    setSignalCorrectionError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${incident.id}/signals/${selectedSignal.id}/correct`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            reason,
            requestId: crypto.randomUUID(),
            expectedVersion: signalCorrectionTarget.expectedVersion,
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (response.status === 409) refreshWorkspace();
        throw new RequestError(
          response.status === 403
            ? 'Platform-operator access is required to correct provider state.'
            : response.status === 409
              ? 'Signal state changed. Review the latest provider record and try again.'
              : body?.error === 'signal not found'
                ? 'Signal is no longer available.'
                : 'Signal correction failed.',
          response.status,
        );
      }
      setSignalCorrectionReason('');
      setSignalCorrectionTarget(null);
      refreshWorkspace();
    } catch (error) {
      setSignalCorrectionError(requestErrorMessage(error, 'Signal correction failed.'));
    } finally {
      setSignalCorrectionPending(false);
    }
  }

  async function deleteIncident() {
    const reason = archiveReason.trim();
    if (!reason || archivePending) return;
    setArchivePending(true);
    setArchiveError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${incident.id}/archive`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            archived: true,
            reason,
            requestId: crypto.randomUUID(),
            expectedVersion: incident.lifecycleVersion,
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (response.status === 409) refreshWorkspace();
        const conflictMessage: Record<string, string> = {
          active: 'Resolve or close the incident before deleting it.',
          active_signals:
            'Provider signals are still active. Clear or correct them before deleting.',
          pending_approvals: 'Resolve pending approvals before deleting this incident.',
          work_in_progress: 'Wait for the current investigation work to finish before deleting.',
          stale: 'Incident state changed. Review it and try again.',
        };
        throw new RequestError(
          (body?.error && conflictMessage[body.error]) || 'Incident deletion failed.',
          response.status,
        );
      }
      setArchiveConfirmation(false);
      setArchiveReason('');
      navigate(productPath('incidents'), { replace: true });
    } catch (error) {
      setArchiveError(requestErrorMessage(error, 'Incident deletion failed.'));
    } finally {
      setArchivePending(false);
    }
  }

  async function confirmRepository(
    provider: 'github' | 'gitlab',
    dataSourceId: string,
    repositoryId: string,
    serviceName: string,
    path: string | null,
  ) {
    if (confirmingRepositoryId) return;
    setConfirmingRepositoryId(
      JSON.stringify([provider, dataSourceId, repositoryId, serviceName, path]),
    );
    setRepositoryConfirmError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${incident.id}/code-context/confirm`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, dataSourceId, repositoryId, serviceName, path }),
        },
      );
      await checkResponse(
        response,
        'Repository confirmation could not be confirmed. Refresh and retry.',
      );
      refreshWorkspace();
    } catch (cause) {
      setRepositoryConfirmError(
        requestErrorMessage(
          cause,
          'Repository confirmation could not be confirmed. Refresh and retry.',
        ),
      );
    } finally {
      setConfirmingRepositoryId(null);
    }
  }

  const view: IncidentLiveViewModel = {
    workspace,
    viewerName,
    getCredentials,
    refreshWorkspace,
    navigate,
    incident,
    assessment,
    stream,
    history,
    evidenceState,
    attachments: attachmentState.attachments,
    attachmentState,
    attachmentDeps,
    draft,
    setDraft,
    zoom,
    setZoom,
    fullAudit,
    setFullAudit,
    lifecycleReason,
    setLifecycleReason,
    lifecyclePending,
    lifecycleError,
    signalCorrectionOpen,
    setSignalCorrectionOpen,
    signalCorrectionTarget,
    setSignalCorrectionTarget,
    signalCorrectionReason,
    setSignalCorrectionReason,
    signalCorrectionPending,
    signalCorrectionError,
    setSignalCorrectionError,
    signalCorrectionStale,
    selectedSignal,
    archiveConfirmation,
    setArchiveConfirmation,
    archiveReason,
    setArchiveReason,
    archivePending,
    archiveError,
    setArchiveError,
    confirmingRepositoryId,
    repositoryConfirmError,
    copyLinkState,
    selectedEvidenceId,
    createdAt,
    canPost,
    sentDelivery,
    hasSlackBinding,
    openEvidence,
    copyIncidentLink,
    submit,
    transitionLifecycle,
    postmortemTrigger,
    setPostmortemTrigger,
    postmortemPending,
    postmortemError,
    generatePostmortem,
    correctSignal,
    deleteIncident,
    confirmRepository,
    decide,
    decisionError,
    activeSignalCount,
    activeSignals,
    allSignalsCleared,
    mergedTargetId,
    needsHuman,
    ownershipLabel,
    ownershipMarker,
    providerState,
    recoveryIsCurrent,
    signals,
  };

  return <IncidentLiveView view={view} />;
}
