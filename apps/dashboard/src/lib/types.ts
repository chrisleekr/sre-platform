import type {
  IncidentAttentionReason,
  ResolutionPolicy,
  ResolutionBasis,
  IncidentFeedbackRecord,
  IncidentTitlePresentation,
  IncidentFindingPayload,
  InvestigationBudgetSnapshot,
  InvestigationGap,
  RecoveryQuestion,
  InvestigationTriggerReason,
  WsMessageDelivery,
} from '@sre/contracts';
import type { IncidentEntityContext } from './entityContext';
import type { PendingIncidentWork } from './investigationRuns';
export interface HubMessage extends WsMessageDelivery {
  id: string;
  incidentId: string;
  author: string;
  kind: string;
  content: string;
  displayContent?: string;
  authorDisplayName?: string;
  summary?: string | null;
  finding?: IncidentFindingPayload | null;
  originMessageId?: string | null;
  originSurface?: string | null;
  authorUserId?: string | null;
  approval?: { id: string; options: { id: string; label: string }[] };
  /** Approval row settled by this message, if any. */
  approvalId?: string | null;
  slackDelivery?: SurfaceDelivery | null;
  slackDeliveries?: SurfaceDelivery[];
  createdAt: string;
}

export type SurfaceDeliveryState =
  'queued' | 'sending' | 'accepted' | 'rejected' | 'uncertain' | 'blocked' | 'skipped';

export interface SurfaceDelivery {
  messageId: string;
  bindingId?: string;
  surface: string;
  state: SurfaceDeliveryState;
  operation: 'post' | 'update' | 'delete' | 'composite';
  remoteMessageId: string | null;
  reasonCode: string | null;
  attemptedAt: string | null;
  completedAt: string | null;
}

/** Incident attachment metadata without file bytes. */
export interface Attachment {
  id: string;
  fileId: string;
  name: string;
  mimetype: string;
  permalink: string | null;
  interpretation: string | null;
  /** The hub message that carried the file; null when attached outside a specific message. */
  messageId: string | null;
}

export interface Incident extends Partial<IncidentTitlePresentation> {
  purpose?: 'incident' | 'health_check';
  id: string;
  service: string;
  severity: string;
  status: string;
  investigationStatus: 'queued' | 'gathering' | 'assessed' | 'degraded';
  lifecycleVersion: number;
  alertSource: string;
  title?: string | null;
  rcaSummary: string | null;
  confidence: number | null;
  trustedAssessmentRunId?: string | null;
  correlationMaxAgeAt?: string | null;
  latestInvestigationRun?: {
    id: string;
    operation: 'investigate' | 'reassess' | 'resume' | 'verify-recovery';
    outcome:
      'conclusive' | 'inconclusive' | 'blocked_missing_capability' | 'budget_exhausted' | 'failed';
    triggerReason: InvestigationTriggerReason | null;
    triggerAutomatic: boolean;
    triggerMonitorKey: string | null;
    triggerMonitorKeys: string[];
    triggerBudget: InvestigationBudgetSnapshot | null;
    summary?: string | null;
    nextStep?: string | null;
    gaps?: string[];
    reason?: string | null;
    completedAt: string;
  } | null;
  pendingAutomation?: PendingIncidentWork | null;
  queuedResponderWork?: PendingIncidentWork | null;
  rankedHypotheses?: Array<{
    hypothesis: string;
    confidence: number;
    evidence: string;
    state?: 'leading' | 'plausible' | 'disfavored' | 'disproven';
    supportingEvidenceIds?: string[];
    contradictingEvidenceIds?: string[];
  }> | null;
  currentState?: string | null;
  impact?: string | null;
  assessmentEvidenceIds?: string[] | null;
  unknowns?: InvestigationGap[] | null;
  nextStep?: string | null;
  assessmentUpdatedAt?: string | null;
  resolutionPolicy?: ResolutionPolicy;
  resolutionBasis?: ResolutionBasis | null;
  recoveryState?: 'verifying' | 'monitoring' | 'verified' | 'not_verified' | null;
  recoverySummary?: string | null;
  recoveryEvidenceIds?: string[] | null;
  recoveryUnknowns?: string[] | null;
  recoveryQuestions?: RecoveryQuestion[] | null;
  recoveryNextStep?: string | null;
  recoveryUpdatedAt?: string | null;
  recoveryAttempt?: number | null;
  recoveryMaxChecks?: number | null;
  recoveryNextCheckAt?: string | null;
  recoveryScheduleReason?: string | null;
  occurrenceCount?: number;
  deployCorrelated?: boolean;
  engineProvider?: string | null;
  engineModel?: string | null;
  resolvedAt?: string | null;
  mitigatedAt?: string | null;
  closedAt?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
  signalCount?: number;
  activeSignalCount?: number;
  pendingApprovalCount?: number;
  requiresHumanAttention?: boolean;
  attentionReason?: IncidentAttentionReason | null;
  operatorDecision?: string | null;
  attentionDecision?: string | null;
  responsibleOwner?: string | null;
  nextAutomation?: { description: string; scheduledAt: string | null } | null;
  // Origin channel. Optional because only GET /incidents joins the surface binding; the
  // topology projection reuses this shape without it.
  /** The channel the incident was born in; null for one with no surface binding. */
  originChannel?: string | null;
  /** That channel's display name; null when no inbound subscription names it. */
  originChannelName?: string | null;
  /** Direct response parent for a causal symptom in the incident queue. */
  causalParentId?: string | null;
  /** Surface and root thread for the detail view's cross-surface context. */
  originSurface?: string | null;
  originThreadId?: string | null;
}

export interface IncidentSignal {
  verifiedProviderState?: 'firing' | 'resolved';
  lifecycleCoverage?: 'binding_required' | 'verified' | 'reverification_required';
  id: string;
  dataSourceId?: string | null;
  provider?: string | null;
  providerFingerprint?: string | null;
  alertName?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  materialHash?: string | null;
  lastInvestigatedMaterialHash?: string | null;
  lastInvestigatedVersion?: number | null;
  correlationMethod?: 'new_incident' | 'stable_subject_window' | null;
  correlationRationale?: string | null;
  correlationFeatures?: string[] | null;
  correlationConfidence?: number | null;
  correlationWindowStartedAt?: string | null;
  correlationWindowExpiresAt?: string | null;
  correlationMaxAgeAt?: string | null;
  surface: string;
  channel: string;
  externalMessageId: string;
  state: 'firing' | 'unknown' | 'resolved';
  lastEventType: 'opened' | 'updated' | 'resolved' | 'refired';
  summary: string;
  version: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface IncidentEvidenceProgress {
  total: number;
  successful: number;
  failed: number;
  lastRecordedAt: string | null;
}

export interface IncidentWorkspaceData {
  incident: Incident;
  serviceTeams?: string[];
  assessmentState?: 'pending' | 'available' | 'invalid';
  viewerUserId: string | null;
  progress: IncidentEvidenceProgress;
  signals: IncidentSignal[];
  relations?: IncidentRelation[];
  investigationSubject?: {
    kind: 'infrastructure_resource' | 'deployment' | 'connector_verification' | 'topology_service';
    sourceId: string;
    subjectId: string;
    sourcePath: string;
    capturedState: 'firing' | 'unknown' | 'resolved';
    capturedSummary: string;
    capturedSnapshot: Record<string, unknown>;
    observedAt: string;
    currentState: 'firing' | 'unknown' | 'resolved';
    currentSummary: string;
    currentSnapshot: Record<string, unknown>;
    lastSyncedAt: string;
  } | null;
  llmUsage?: {
    incidentId: string;
    invocations: number;
    configuredCostUsd: number;
    providerEstimatedCostUsd: number | null;
    unpriced: number;
    missingUsage: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  codeContext?: {
    resolvedServices: string[];
    repositories: IncidentCodeRepository[];
    events: IncidentCodeEvent[];
  };
  entityContext?: IncidentEntityContext | null;
  feedback?: IncidentFeedbackRecord[];
  feedbackEligibleFindingRunIds?: string[];
  attention?: {
    decision: string;
    owner: string | null;
    nextAutomation: { description: string; scheduledAt: string | null } | null;
  } | null;
  /** Advisory Slack recovery notices linked to this incident's signals, oldest first. */
  providerRecoveryReports?: Array<{ signalId: string; reportedAt: string }>;
  automation?: {
    nextAction: { description: string; scheduledAt: string | null } | null;
    currentBudget: InvestigationBudgetSnapshot | null;
    episodeExpiresAt: string | null;
  };
  tags?: Array<{ id: string; tag: string }>;
  tagSuggestions?: Array<{ id: string; tag: string }>;
  tagLinkRules?: Array<{ prefix: string; urlTemplate: string }>;
  tagHistorySuggestions?: Array<{ tag: string; appliedCount: number }>;
}

export interface IncidentRelation {
  id: string;
  sourceIncidentId: string;
  targetIncidentId: string;
  type:
    'possible_related' | 'caused_by' | 'recurrence_of' | 'merged_into' | 'split_from' | 'unrelated';
  rationale: string;
  evidence: string[];
  decidedBy: 'system' | 'agent' | 'human';
  decidedByUserId: string | null;
  evidenceIds?: string[];
  confidence?: number | null;
  decisionRunId?: string | null;
  correlationFeedback?: {
    decision: 'group' | 'separate';
    sourceScopeKeys: string[];
    targetScopeKeys: string[];
    sharedScopeKeys: string[];
  } | null;
  createdAt: string;
  sourceIncident?: IncidentRelationSummary;
  targetIncident?: IncidentRelationSummary;
}

export interface IncidentRelationSummary {
  id: string;
  title: string | null;
  service: string;
  severity: string;
  status: string;
  investigationStatus: 'queued' | 'gathering' | 'assessed' | 'degraded';
  rcaSummary?: string | null;
  confidence?: number | null;
  assessmentUpdatedAt?: string | null;
  createdAt: string;
}

export interface IncidentCodeRepository {
  serviceName: string;
  provider: 'github' | 'gitlab';
  dataSourceId: string;
  dataSourceName: string;
  repositoryId: string;
  fullName: string;
  defaultBranch: string | null;
  private: boolean;
  archived: boolean;
  htmlUrl: string;
  path: string | null;
  source: 'mapping' | 'exact_name';
  confirmed: boolean;
}

export interface IncidentCodeEvent {
  provider: 'github' | 'gitlab';
  dataSourceId: string;
  dataSourceName: string;
  eventType: string;
  action: string | null;
  repositoryFullName: string | null;
  actor: string | null;
  ref: string | null;
  sha: string | null;
  summary: Record<string, unknown>;
  occurredAt: string;
}

export interface EvidenceListItem {
  summary?: string | null;
  id: string;
  tool: string;
  outcome: string;
  latencyMs: number;
  recordedAt: string;
  hasOutput: boolean;
}

export interface EvidenceDetail extends EvidenceListItem {
  input: unknown;
  output: unknown | null;
  projection:
    | {
        kind: 'time_series';
        source: 'prometheus' | 'datadog';
        query: string;
        from: string | null;
        to: string | null;
        series: Array<{
          name: string;
          unit: string | null;
          points: Array<{ timestamp: string; value: number }>;
        }>;
      }
    | {
        kind: 'code';
        status: string;
        artifacts: Array<{
          dataSourceName: string;
          identity: string;
          namespace: string;
          workload: string | null;
          container: string;
          revision: string | null;
        }>;
        revisions: Array<{
          repository: string;
          role: string;
          basis: string;
          strength: string;
          revision: string | null;
          providerUrl: string | null;
          deployedAt: string | null;
        }>;
        matches: Array<{
          repository: string;
          revision: string;
          strength: string;
          path: string;
          startLine: number;
          endLine: number;
          excerpt: string;
          providerUrl: string | null;
          changedFromPreviousRevision: boolean | null;
        }>;
        uncertainties: string[];
        requiredSetup: string[];
      }
    | {
        kind: 'facts';
        columns: string[];
        rows: Array<Record<string, string | number | boolean | null>>;
      }
    | { kind: 'raw' };
  referenceUrl: string | null;
}

export interface PanelDef {
  path: string;
  label: string;
  group: 'Respond' | 'Observe' | 'Configure';
}

export { PANELS } from './panels';

export interface InfraSnapshot {
  dataSourceId: string;
  dataSourceName: string;
  source: string; // datadog | prometheus | aws | kubernetes | ...
  entityId: string; // service / cluster / db identifier
  metrics: Record<string, number>;
  observedAt: string; // ISO timestamp
  error?: string; // connector error, if the snapshot failed
  kind?: 'pod' | 'node';
  namespace?: string;
  labels?: Record<string, string>;
  phase?: string;
  containers?: Array<{
    name?: string;
    ready: boolean;
    restartCount: number;
    terminatedReason?: string;
    waitingReason?: string;
    lastTerminatedReason?: string;
    lastTerminatedAt?: string;
  }>;
  pressures?: string[];
}

/** A snapshot older than this is shown as stale. */
export const INFRA_STALE_AFTER_MS = 60_000;

/** Normalized outcome from connectors' DEPLOY_STATUSES, not a provider's raw status. */
export type DeployStatus =
  | 'success'
  | 'failed'
  | 'failure'
  | 'error'
  | 'running'
  | 'pending'
  | 'blocked'
  | 'canceled'
  | 'inactive';

export type { SloEvaluation, SloRow } from './slo-types';

export interface Deployment {
  id?: string;
  dataSourceId?: string;
  dataSourceName: string;
  source: string; // github | gitlab | argocd
  providerId?: string;
  service?: string;
  repo: string; // owner/repo or project path
  ref: string; // branch or tag
  environment?: string;
  transientEnvironment: boolean;
  actor?: string;
  sha: string; // full provider revision
  revisions?: string[];
  operationPhase?: string;
  status: DeployStatus;
  deployedAt: string; // ISO timestamp
  providerCreatedAt?: string;
  providerUpdatedAt?: string;
  url?: string; // pipeline / deploy URL
  // Advisory error-budget stamp taken when the deploy was recorded. Absent when the service has no
  // objective or none has been evaluated. Reporting only: the platform never blocks a deploy.
  budgetRemaining?: number;
  highRisk?: boolean;
}

export interface GitOpsApplication {
  dataSourceId: string;
  dataSourceName: string;
  source: 'argocd';
  entityId: string;
  applicationId: string;
  applicationName: string;
  applicationNamespace: string;
  project: string;
  syncStatus?: string;
  healthStatus?: string;
  healthMessage?: string;
  operationPhase?: string;
  operationMessage?: string;
  revisions: string[];
  destinationServer?: string;
  destinationNamespace?: string;
  conditions: Array<{ type?: string; message?: string; lastTransitionTime?: string }>;
  observedAt: string;
  url?: string;
}

export interface ChangeEvent {
  id: string;
  provider: 'github' | 'gitlab';
  dataSourceId: string | null;
  dataSourceName: string;
  category: 'code' | 'review' | 'ci' | 'release';
  eventType: string;
  action?: string;
  repository?: string;
  actor?: string;
  ref?: string;
  sha?: string;
  title: string;
  status?: string;
  url?: string;
  occurredAt: string;
}
