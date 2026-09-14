import type { CredentialGetter } from '../../lib/request-credentials';
import type { useAttachments } from '../../lib/useAttachments';
import type { Dispatch, SetStateAction } from 'react';
import type { useNavigate } from 'react-router-dom';
import type { assessmentLabel } from '../../lib/incidentState';
import type {
  Attachment,
  IncidentSignal,
  IncidentWorkspaceData,
  SurfaceDelivery,
} from '../../lib/types';
import type { useIncidentEvidence } from '../../lib/useIncidentEvidence';
import type { useIncidentHistory } from '../../lib/useIncidentHistory';
import type { useWsStream } from '../../lib/useWsStream';
import type { AttachmentDeps } from '../MessageAttachments';
import type { PostmortemTrigger } from '@sre/contracts';
import type { LifecycleStatus } from './signals';
import type { deriveIncidentState } from './state';

export interface IncidentLiveViewModel {
  workspace: IncidentWorkspaceData;
  viewerName?: string;
  getCredentials: CredentialGetter;
  refreshWorkspace: () => void;
  navigate: ReturnType<typeof useNavigate>;
  incident: IncidentWorkspaceData['incident'];
  assessment: ReturnType<typeof assessmentLabel>;
  stream: ReturnType<typeof useWsStream>;
  history: ReturnType<typeof useIncidentHistory>;
  evidenceState: ReturnType<typeof useIncidentEvidence>;
  attachments: Attachment[];
  attachmentDeps: AttachmentDeps;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  zoom: string | null;
  setZoom: Dispatch<SetStateAction<string | null>>;
  fullAudit: boolean;
  setFullAudit: Dispatch<SetStateAction<boolean>>;
  lifecycleReason: string;
  setLifecycleReason: Dispatch<SetStateAction<string>>;
  lifecyclePending: LifecycleStatus | null;
  lifecycleError: string | null;
  signalCorrectionOpen: boolean;
  setSignalCorrectionOpen: Dispatch<SetStateAction<boolean>>;
  signalCorrectionTarget: { id: string; expectedVersion: number } | null;
  setSignalCorrectionTarget: Dispatch<
    SetStateAction<{ id: string; expectedVersion: number } | null>
  >;
  signalCorrectionReason: string;
  setSignalCorrectionReason: Dispatch<SetStateAction<string>>;
  signalCorrectionPending: boolean;
  signalCorrectionError: string | null;
  setSignalCorrectionError: Dispatch<SetStateAction<string | null>>;
  signalCorrectionStale: boolean;
  selectedSignal: IncidentSignal | null;
  archiveConfirmation: boolean;
  setArchiveConfirmation: Dispatch<SetStateAction<boolean>>;
  archiveReason: string;
  setArchiveReason: Dispatch<SetStateAction<string>>;
  archivePending: boolean;
  archiveError: string | null;
  setArchiveError: Dispatch<SetStateAction<string | null>>;
  confirmingRepositoryId: string | null;
  repositoryConfirmError: string | null;
  copyLinkState: 'idle' | 'copied' | 'failed';
  createdAt: string;
  canPost: boolean;
  canEditDraft: boolean;
  inspectorOpen: boolean;
  inspectorId: string | null;
  inspectorContext: string | null;
  evidenceTrigger: HTMLElement | null;
  closeEvidence: () => void;
  showAllEvidence: () => void;
  newMessageCount: number;
  conversationReviewNeeded: boolean;
  showNewMessages: () => void;
  sentDelivery: SurfaceDelivery | null | undefined;
  hasSlackBinding: boolean;
  openEvidence: (evidenceId: string, context?: string) => void;
  copyIncidentLink: () => Promise<void>;
  submit: () => void;
  transitionLifecycle: (to: LifecycleStatus) => Promise<void>;
  postmortemTrigger: PostmortemTrigger | '';
  setPostmortemTrigger: Dispatch<SetStateAction<PostmortemTrigger | ''>>;
  postmortemPending: boolean;
  postmortemError: string | null;
  generatePostmortem: () => Promise<void>;
  correctSignal: () => Promise<void>;
  deleteIncident: () => Promise<void>;
  confirmRepository: (
    provider: 'github' | 'gitlab',
    dataSourceId: string,
    repositoryId: string,
    serviceName: string,
    path: string | null,
  ) => Promise<void>;
  decide: (approvalId: string, optionId: string) => void;
  decisionError: string | null;
  attachmentState: ReturnType<typeof useAttachments>;
  activeSignalCount: number;
  activeSignals: IncidentSignal[];
  allSignalsCleared: boolean;
  mergedTargetId: string | undefined;
  needsHuman: boolean;
  ownershipLabel: string;
  ownershipMarker: string;
  providerState: ReturnType<typeof deriveIncidentState>['providerState'];
  recoveryIsCurrent: boolean;
  signals: IncidentSignal[];
}
