import type { ToolAuditSink, ToolContext, ToolDefinition } from '@sre/agent-tools';
import type { AutomaticInvestigationBudgetLimits, InvestigationOperation } from '@sre/contracts';
import type { CausalCandidate, Db, getIncident } from '@sre/db';
import type { ConversationHub } from '@sre/hub';
import type { Queue } from '@sre/queue';
import type { StructuredGenerator, TriageEngine, VisionModel } from '../engine/types';
import type { LlmRuntimeManager } from '../llm-runtime';
import type { IncidentLock } from '../lock';
import type { RunbookSeeder } from '../runbook-seeder';
import type { SubjectSyncObservation } from '../subject-sync';

/** Transient bytes of a human-attached file returned by a surface file fetcher. */
export type AttachmentFetcher = (
  tenantId: string,
  urlPrivate: string,
) => Promise<{ bytes: ArrayBuffer; contentType: string }>;

export type IncidentRow = NonNullable<Awaited<ReturnType<typeof getIncident>>>;
export type RecoveryOutcome = 'recovered' | 'recheck' | 'needs_human';

export interface RecoveryPersistContext {
  /** Incident that owns lifecycle and scheduled recovery for the complete causal response group. */
  responseRootIncidentId: string;
  /** Run that owns a scheduled recovery's transient verification state. */
  verificationRunId?: string;
  /** Durable recovery queue job retargeted only after an active lifecycle race. */
  recoveryJobId?: string;
  expectedLifecycleVersion: number;
  expectedSignalFence: string;
  restoreInvestigationStatus: IncidentRow['investigationStatus'];
  verificationStartedAt: Date;
  attempt: number;
  maxChecks: number;
  eventKey: string;
  transitionKey: string;
  signals: Array<{ id: string; version: number; materialHash: string | null }>;
  resumeMessageId?: string;
}

export interface PersistOptions {
  humanMessageFence?: string | null;
  operation?: InvestigationOperation;
  runId?: string;
  priorInvestigationStatus?: IncidentRow['investigationStatus'];
  resumeMessageId?: string;
  rcaFrozen?: boolean;
  assessmentCause?: 'signal';
  resultOriginMessageId?: string;
  assessmentSignalScope?: 'complete' | 'causal';
  assessedMaterials?: Array<{
    signalId: string;
    signalVersion?: number;
    materialHash: string;
  }>;
  /** Exact server-side candidate mapping rendered into a causal reassessment prompt. */
  causalCandidates?: CausalCandidate[];
  recovery?: RecoveryPersistContext;
}

/** Runtime dependencies for one triage worker process. */
export interface TriageWorkerDeps {
  appDb: Db;
  hub: ConversationHub;
  llm?: LlmRuntimeManager;
  engine?: TriageEngine;
  generator?: StructuredGenerator;
  queue: Queue;
  runbookQueue?: Queue;
  resolveInvestigationSubject?: (
    tenantId: string,
    subject: NonNullable<Awaited<ReturnType<typeof import('@sre/db').getInvestigationSubject>>>,
  ) => Promise<SubjectSyncObservation>;
  auditSink: ToolAuditSink;
  connectorProvider: (tenantId: string) => ToolContext['resolveConnectors'];
  tools: ToolDefinition<any, any>[];
  lock: IncidentLock;
  clearResumeGate: (incidentId: string) => Promise<void>;
  getRecoveryMaxChecks?: () => Promise<number>;
  getEvidenceRowLimit?: () => Promise<number>;
  getEvidenceBudgetChars?: () => Promise<number>;
  getAutomaticInvestigationBudget?: () => Promise<AutomaticInvestigationBudgetLimits>;
  runbookSeeder?: RunbookSeeder;
  vision?: VisionModel;
  fetchAttachment?: AttachmentFetcher;
}
