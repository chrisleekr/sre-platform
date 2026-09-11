import type { Job, JobContext } from '@sre/queue';
import type { TriageWorkerDeps } from './worker/contracts';
import { WorkerDisposition } from './worker/disposition';
import { WorkerEvidence } from './worker/evidence';
import { ReassessmentHandler } from './worker/reassessment';
import { RecoveryHandler } from './worker/recovery';
import { ResumeHandler } from './worker/resume';
import { WorkerRuntime } from './worker/runtime';
import { SubjectSyncHandler } from './worker/subject-sync';
import { TriageHandler } from './worker/triage';
import { CohortAnalysisHandler } from './worker/cohort-analysis';
import { RelationReassessmentHandler } from './worker/relation-reassessment';

export type { AttachmentFetcher, TriageWorkerDeps } from './worker/contracts';
export { ELISION_MARKER, splitResumeInput, transcriptBudgetChars } from './worker/transcript';

/** Dispatches durable investigation jobs to focused lifecycle handlers. */
export class TriageWorker {
  private readonly runtime: WorkerRuntime;
  private readonly triage: TriageHandler;
  private readonly resume: ResumeHandler;
  private readonly reassessment: ReassessmentHandler;
  private readonly recovery: RecoveryHandler;
  private readonly subjectSync: SubjectSyncHandler;
  private readonly cohortAnalysis: CohortAnalysisHandler;
  private readonly relationReassessment: RelationReassessmentHandler;

  /**
   * Create a worker from its database, queue, connector, and model dependencies.
   *
   * @param deps - Process-scoped worker dependencies.
   */
  constructor(deps: TriageWorkerDeps) {
    this.runtime = new WorkerRuntime(deps);
    const disposition = new WorkerDisposition(this.runtime);
    const evidence = new WorkerEvidence(this.runtime);
    this.triage = new TriageHandler(this.runtime, disposition, evidence);
    this.resume = new ResumeHandler(this.runtime, disposition, evidence);
    this.reassessment = new ReassessmentHandler(this.runtime, disposition);
    this.recovery = new RecoveryHandler(this.runtime, disposition);
    this.subjectSync = new SubjectSyncHandler(this.runtime);
    this.cohortAnalysis = new CohortAnalysisHandler(this.runtime);
    this.relationReassessment = new RelationReassessmentHandler(this.runtime, disposition);
  }

  /**
   * Handle one durable queue job.
   *
   * @param job - Claimed job to execute.
   * @param ctx - Per-attempt processing context.
   */
  async handle(job: Job, ctx: JobContext): Promise<void> {
    if (job.type === 'triage') return this.triage.handle(job, ctx);
    if (job.type === 'resume') return this.resume.handle(job, ctx);
    if (job.type === 'signal.reassess') return this.reassessment.handle(job, ctx);
    if (job.type === 'recovery.verify') return this.recovery.handle(job, ctx);
    if (job.type === 'subject.sync') return this.subjectSync.handle(job);
    if (job.type === 'cohort.analyze') return this.cohortAnalysis.handle(job, ctx.signal);
    if (job.type === 'relation.reassess') return this.relationReassessment.handle(job, ctx);
    console.warn(
      JSON.stringify({
        level: 'warn',
        app: 'triage-worker',
        msg: 'unknown job type',
        type: job.type,
        jobId: job.id,
      }),
    );
  }

  /**
   * Process one queue batch.
   *
   * @param consumer - Queue consumer identity.
   */
  tick(consumer = 'triage-worker'): Promise<number> {
    return this.runtime.deps.queue.process(consumer, (job, ctx) => this.handle(job, ctx));
  }
}
