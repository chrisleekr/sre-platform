import { connectorTools, type ToolContext, type ToolDefinition } from '@sre/agent-tools';
import { LockContentionError, type Job } from '@sre/queue';
import { getIncidentEvidence } from '@sre/db';
import {
  type InvestigationExecutionMetadata,
  type TranscriptKind,
  type TriageEngine,
  type VisionModel,
  type StructuredGenerator,
} from '../engine/types';
import type { EvidenceReceipt } from '../engine/evidence-closure';
import { publicModelText } from '../public-output';
import type { IncidentRow, TriageWorkerDeps } from './contracts';
import { platformIdentityContext } from './platform-identity';

export interface EngineToolRuntime {
  readEvidence: NonNullable<import('../engine/types').TriageRuntime['readEvidence']>;
  ctx: ToolContext;
  tools: ToolDefinition<any, any>[];
  signal: AbortSignal;
  onStep: (kind: TranscriptKind, content: string) => Promise<void>;
  executionMetadata: InvestigationExecutionMetadata | null;
  evidenceReceipts: EvidenceReceipt[];
  onExecutionMetadata: (metadata: InvestigationExecutionMetadata) => void;
  onEvidenceReceipt: (receipt: EvidenceReceipt) => void;
  /** Logins of this platform's own connections, for the investigation context; empty when none. */
  platformIdentity?: string;
}

export class WorkerRuntime {
  constructor(readonly deps: TriageWorkerDeps) {}

  async withEngineLock(incidentId: string, run: () => Promise<void>): Promise<void> {
    const token = await this.deps.lock.acquire(incidentId);
    if (!token) throw new LockContentionError('engine busy for this incident; redelivering');
    try {
      await run();
    } finally {
      await this.deps.lock.release(incidentId, token);
    }
  }

  async tools(
    tenantId: string,
    incident: IncidentRow,
    options: { mirrorSteps?: boolean; signal: AbortSignal },
  ): Promise<EngineToolRuntime> {
    const ctx: ToolContext = {
      tenantId,
      incidentId: incident.id,
      service: incident.service,
      resolveConnectors: this.deps.connectorProvider(tenantId),
      audit: this.deps.auditSink,
      signal: options.signal,
    };
    const connectors = await ctx.resolveConnectors();
    const tools = [...this.deps.tools, ...connectors.flatMap(connectorTools)];
    const platformIdentity = await platformIdentityContext(connectors, { signal: options.signal });
    let executionMetadata: InvestigationExecutionMetadata | null = null;
    const evidenceReceipts: EvidenceReceipt[] = [];
    const onStep = async (kind: TranscriptKind, content: string): Promise<void> => {
      await this.deps.hub.append(tenantId, incident.id, {
        author: 'agent',
        kind: options.mirrorSteps === false ? 'status' : kind,
        content: publicModelText(content),
      });
    };
    return {
      readEvidence: async (id) => {
        const row = await getIncidentEvidence(this.deps.appDb, tenantId, incident.id, id);
        return row
          ? {
              id: row.id,
              tool: row.tool,
              input: row.input,
              output: row.output,
              createdAt: row.recordedAt,
              outcome: row.outcome,
            }
          : null;
      },
      ctx,
      tools,
      platformIdentity,
      signal: options.signal,
      onStep,
      get executionMetadata() {
        return executionMetadata;
      },
      evidenceReceipts,
      onExecutionMetadata(metadata) {
        executionMetadata = metadata;
      },
      onEvidenceReceipt(receipt) {
        const index = evidenceReceipts.findIndex(
          (current) => current.evidenceId === receipt.evidenceId,
        );
        if (index === -1) evidenceReceipts.push(receipt);
        else evidenceReceipts[index] = receipt;
      },
    };
  }

  incidentInput(tenantId: string, incident: IncidentRow) {
    return {
      id: incident.id,
      tenantId,
      service: incident.service,
      severity: incident.severity,
      fingerprint: incident.fingerprint,
      alertSource: incident.alertSource,
    };
  }

  executeEngine<T>(
    job: Job,
    incidentId: string,
    operation: 'investigate' | 'reassess' | 'resume' | 'verify-recovery',
    signal: AbortSignal,
    run: (engine: TriageEngine) => Promise<T>,
  ): Promise<T> {
    if (this.deps.llm) {
      return this.deps.llm.execute(
        { tenantId: job.tenantId, incidentId, jobId: job.id, operation, signal },
        ({ engine }) => run(engine),
      );
    }
    if (!this.deps.engine) throw new Error('LLM runtime is not configured');
    return run(this.deps.engine);
  }

  executeVision<T>(
    job: Job,
    incidentId: string,
    signal: AbortSignal,
    run: (vision: VisionModel) => Promise<T>,
  ): Promise<T> {
    if (this.deps.llm) {
      return this.deps.llm.execute(
        {
          tenantId: job.tenantId,
          incidentId,
          jobId: job.id,
          operation: 'interpret-image',
          signal,
        },
        ({ vision }) => run(vision),
      );
    }
    if (!this.deps.vision) throw new Error('vision model is not configured');
    return run(this.deps.vision);
  }

  /** Run bounded semantics through the configured provider, without connector tools.
   * @param job - Tenant-scoped durable request.
   * @param operation - Semantic operation used for usage accounting.
   * @param signal - Attempt deadline.
   * @param run - Domain classification using the structured generator.
   */
  executeSemantic<T>(
    job: { tenantId: string; id?: string },
    operation: 'responder-intent' | 'assessment-reconcile',
    signal: AbortSignal,
    run: (generator: StructuredGenerator) => Promise<T>,
  ): Promise<T> {
    if (this.deps.llm)
      return this.deps.llm.execute(
        { tenantId: job.tenantId, jobId: job.id, operation, signal },
        ({ generator }) => run(generator),
      );
    if (!this.deps.generator) throw new Error('Structured model runtime is not configured');
    return run(this.deps.generator);
  }
}
