import type { InvestigationTriggerReason } from '@sre/contracts';
import type { Db, Tx } from '@sre/db';
import type { Redis } from 'ioredis';
import { QueueConsumer } from './queue/consumer';
import { ClassifyJobWriter } from './queue/classify-writer';
import {
  JOB_STREAM_MAXLEN,
  type ClassifyEnqueueResult,
  type JobInput,
  type QueueOptions,
} from './queue/contracts';
import { QueuePublisher } from './queue/publisher';
import { QueueWriter } from './queue/writer';

export {
  DEFAULT_MAX_PROCESSING_MS,
  DEFAULT_STUCK_GRACE_MS,
  DeadlineExceededError,
  IncidentMovedError,
  IncidentUnavailableError,
  LockContentionError,
  RetryableError,
  NonRetryableError,
  pruneTerminalJobs,
  resumeGateKey,
  type ClaimedDelivery,
  type ClassifyEnqueueResult,
  type Job,
  type JobContext,
  type JobHandler,
  type JobInput,
  type QueueOptions,
  type StuckJobInfo,
} from './queue/contracts';
export {
  mergeReassessmentSignalChanges,
  reassessmentSignalChanges,
  reassessmentTriggerReason,
} from './queue/reassessment';

/** Runs a Valkey delivery stream with Postgres as the durable job authority. */
export class Queue extends QueueConsumer {
  private readonly writer: QueueWriter;
  private readonly publisher: QueuePublisher;
  private readonly classifyWriter: ClassifyJobWriter;

  constructor(db: Db, redis: Redis, opts: QueueOptions = {}) {
    super(db, redis, opts);
    const streamMaxLen = opts.streamMaxLen ?? JOB_STREAM_MAXLEN;
    const dispatchRedis = opts.dispatchRedis ?? redis;
    this.writer = new QueueWriter(db, dispatchRedis, this.stream, streamMaxLen);
    this.publisher = new QueuePublisher(
      db,
      redis,
      dispatchRedis,
      this.stream,
      streamMaxLen,
      this.writer,
    );
    this.classifyWriter = new ClassifyJobWriter(db, this.stream);
  }

  async enqueue(input: JobInput): Promise<string> {
    return this.writer.enqueue(input);
  }

  /**
   * Makes classify work durable without dispatching it. Call {@link publishJob} after commit-time caches.
   *
   * @param input - Classify job carrying durable receipt and provider-event identities.
   */
  async insertClassify(input: JobInput): Promise<ClassifyEnqueueResult> {
    const result = await this.classifyWriter.insert(input);
    return {
      jobId: result.jobId,
      inserted: result.inserted,
      matchedBy: result.matchedBy,
    };
  }

  /**
   * Makes classify work durable on an existing transaction before post-commit dispatch.
   *
   * @param tx - Existing transaction holding any provider-message admission lock.
   * @param input - Classify job carrying durable receipt and provider-event identities.
   */
  async insertClassifyTx(tx: Tx, input: JobInput): Promise<ClassifyEnqueueResult> {
    return this.classifyWriter.insertTx(tx, input);
  }

  async insertResumeTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    humanMessageId: string,
  ): Promise<{ jobId: string | null }> {
    return this.writer.insertResumeTx(tx, tenantId, incidentId, humanMessageId);
  }

  async insertRecoveryTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    lifecycleVersion: number,
    signalFence: string,
    options: {
      attempt?: number;
      maxChecks?: number;
      availableAt?: Date;
      scheduleReason?: string;
    } = {},
  ): Promise<{ jobId: string | null }> {
    return this.writer.insertRecoveryTx(
      tx,
      tenantId,
      incidentId,
      lifecycleVersion,
      signalFence,
      options,
    );
  }

  async insertReassessmentTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    signalId: string,
    signalVersion: number,
    triggerReason: InvestigationTriggerReason = 'material_change',
  ): Promise<{ jobId: string | null }> {
    return this.writer.insertReassessmentTx(
      tx,
      tenantId,
      incidentId,
      signalId,
      signalVersion,
      triggerReason,
    );
  }

  async insertSubjectSyncTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    availableAt: Date,
  ): Promise<{ jobId: string | null }> {
    return this.writer.insertSubjectSyncTx(tx, tenantId, incidentId, availableAt);
  }

  /** Makes one fixed-cohort analysis durable for dispatch after its collection window. */
  async insertCohortAnalysisTx(
    tx: Tx,
    tenantId: string,
    cohortId: string,
    availableAt: Date,
  ): Promise<{ jobId: string | null }> {
    return this.writer.insertCohortAnalysisTx(tx, tenantId, cohortId, availableAt);
  }

  /** Makes one evidence-gathering relation reassessment durable per incident. */
  async insertRelationReassessmentTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
  ): Promise<{ jobId: string | null }> {
    return this.writer.insertRelationReassessmentTx(tx, tenantId, incidentId);
  }

  async insertJobTx(tx: Tx, input: JobInput): Promise<string> {
    return this.writer.insertJobTx(tx, input);
  }

  async publishJob(jobId: string): Promise<void> {
    return this.publisher.publishJob(jobId);
  }

  async publishResume(jobId: string): Promise<void> {
    return this.publisher.publishResume(jobId);
  }

  async dispatchDue(limit = 100): Promise<number> {
    return this.publisher.dispatchDue(limit);
  }

  async enqueueResume(
    tenantId: string,
    incidentId: string,
    humanMessageId: string,
  ): Promise<string | null> {
    return this.publisher.enqueueResume(tenantId, incidentId, humanMessageId);
  }

  async clearResumeGate(incidentId: string): Promise<void> {
    return this.publisher.clearResumeGate(incidentId);
  }
}
