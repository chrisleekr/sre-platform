import { scrubSecrets } from '@sre/agent-tools';
import {
  getIncident,
  listIncidentRelations,
  listIncidentSignals,
  markSignalMaterialInvestigated,
  prepareResponseGroupRecoveryTx,
  setInvestigationStatus,
  startInvestigatingWithMessages,
  withTenant,
} from '@sre/db';
import type { Job, JobContext } from '@sre/queue';
import { renderSloBrief, sloStatusForService } from '@sre/slo';
import { computeIncidentBlastRadius, renderBlastRadius } from '@sre/topology';
import { renderIncidentRelationContext } from '../relation-context';
import type { WorkerDisposition } from './disposition';
import type { WorkerEvidence } from './evidence';
import { renderRunbookSeeds } from './presentation';
import type { EngineToolRuntime, WorkerRuntime } from './runtime';
import { captureResponderContext } from './responder-context';

export class TriageHandler {
  constructor(
    private readonly runtime: WorkerRuntime,
    private readonly disposition: WorkerDisposition,
    private readonly evidence: WorkerEvidence,
  ) {}

  async handle(job: Job, ctx: JobContext): Promise<void> {
    const { deps } = this.runtime;
    const payload = (job.payload ?? {}) as {
      incidentId?: string;
      alert?: unknown;
      title?: string;
      signalMaterials?: Array<{
        signalId: string;
        signalVersion?: number;
        materialHash: string;
      }>;
    };
    const incidentId = payload.incidentId;
    if (!incidentId) return;
    await this.runtime.withEngineLock(incidentId, async () => {
      const resultOriginMessageId = `triage-assessment:${job.id}`;
      const committed = await deps.hub.appendedByOrigin(
        job.tenantId,
        incidentId,
        resultOriginMessageId,
      );
      if (committed) {
        await deps.hub.publishAppended(committed);
        await this.finishProviderTriage(job.tenantId, incidentId, payload.signalMaterials ?? []);
        return;
      }
      const incident = await getIncident(deps.appDb, job.tenantId, incidentId);
      if (!incident) return;
      if (
        job.createdAt &&
        incident.assessmentUpdatedAt &&
        job.createdAt.getTime() <= incident.assessmentUpdatedAt.getTime()
      )
        return;
      const admission = await this.disposition.admitRun(job, incident, 'investigate');
      if (!admission.admitted) return;
      const runId = admission.id;
      let toolRuntime: EngineToolRuntime | undefined;
      let executeRun: (() => Promise<boolean>) | null = null;
      try {
        const [blastRadius, runbookSection, budgetSection, relationSection] = await Promise.all([
          (async () => {
            try {
              return renderBlastRadius(
                await computeIncidentBlastRadius(
                  deps.appDb,
                  job.tenantId,
                  incidentId,
                  incident.service,
                ),
              );
            } catch {
              return `Blast radius for "${incident.service}": unavailable (topology query failed).`;
            }
          })(),
          (async () => {
            try {
              const seeds = deps.runbookSeeder
                ? await deps.runbookSeeder(job.tenantId, {
                    title: payload.title,
                    service: incident.service,
                    severity: incident.severity,
                  })
                : [];
              return scrubSecrets(renderRunbookSeeds(seeds));
            } catch {
              return '';
            }
          })(),
          (async () => {
            try {
              // Advisory context for the responder: how much error budget the service has left. The
              // budget never opens or escalates anything, and a read failure degrades to no section
              // rather than failing the open, so a tenant with no objectives sees today's brief.
              //
              // Scrubbed like the runbook and relation sections: the brief interpolates the
              // objective's tenant-authored name and service, and this message is persisted as
              // authored by 'system' in the durable conversation log and replayed into the model
              // context on every open for the service. A credential pasted into an objective name
              // would otherwise never be redacted from that log.
              return scrubSecrets(
                renderSloBrief(
                  await sloStatusForService(deps.appDb, job.tenantId, incident.service),
                ),
              );
            } catch {
              return '';
            }
          })(),
          (async () => {
            try {
              return scrubSecrets(
                renderIncidentRelationContext(
                  incident.id,
                  await listIncidentRelations(deps.appDb, job.tenantId, incident.id),
                ),
              );
            } catch {
              return '';
            }
          })(),
        ]);
        const brief = [blastRadius, runbookSection, budgetSection].filter(Boolean).join('\n\n');
        const opener = await startInvestigatingWithMessages(deps.appDb, job.tenantId, incidentId, [
          { author: 'system', kind: 'status', content: 'Triage started.' },
          { author: 'system', kind: 'status', content: brief },
        ]);
        if (opener) for (const row of opener) await deps.hub.publishPersisted(row);
        const firstPassEvidence = await this.evidence.seedFirstPass(job.tenantId, incident);
        const screenshots = await this.evidence.interpretAttachments(job, incident, ctx.signal);
        const responder = await captureResponderContext(this.runtime, job.tenantId, incident.id);
        const context = [brief, relationSection, screenshots, responder.text]
          .filter(Boolean)
          .join('\n\n');
        const alert =
          responder.fence &&
          payload.alert &&
          typeof payload.alert === 'object' &&
          !Array.isArray(payload.alert)
            ? Object.fromEntries(
                Object.entries(payload.alert).filter(([key]) => key !== 'currentMessage'),
              )
            : payload.alert;
        const runtime = await this.runtime.tools(job.tenantId, incident, { signal: ctx.signal });
        toolRuntime = runtime;
        executeRun = () =>
          this.disposition.runEngine(
            job.tenantId,
            incident,
            runtime,
            () =>
              this.runtime.executeEngine(job, incident.id, 'investigate', ctx.signal, (engine) =>
                engine.investigate(
                  {
                    incident: this.runtime.incidentInput(job.tenantId, incident),
                    alert,
                    context: [context, runtime.platformIdentity].filter(Boolean).join('\n\n'),
                    evidence: firstPassEvidence,
                  },
                  runtime,
                ),
              ),
            {
              operation: 'investigate',
              humanMessageFence: responder.fence,
              runId,
              resultOriginMessageId,
              assessedMaterials: payload.signalMaterials ?? [],
            },
          );
      } catch (error) {
        const failed = await this.disposition.failRun(
          job.tenantId,
          incident.id,
          runId,
          'Investigation setup failed.',
          toolRuntime,
        );
        if (failed)
          await setInvestigationStatus(
            deps.appDb,
            job.tenantId,
            incident.id,
            incident.trustedAssessmentRunId || incident.rcaSummary ? 'assessed' : 'degraded',
          );
        throw error;
      }
      if (executeRun && (await executeRun()))
        await this.finishProviderTriage(job.tenantId, incident.id, payload.signalMaterials ?? []);
    });
  }

  private async finishProviderTriage(
    tenantId: string,
    incidentId: string,
    assessedMaterials: Array<{
      signalId: string;
      signalVersion?: number;
      materialHash: string;
    }>,
  ): Promise<void> {
    const { deps } = this.runtime;
    await Promise.all(
      assessedMaterials.map(({ signalId, signalVersion, materialHash }) =>
        markSignalMaterialInvestigated(deps.appDb, tenantId, signalId, materialHash, signalVersion),
      ),
    );
    const signals = await listIncidentSignals(deps.appDb, tenantId, incidentId);
    if (
      !signals.some((signal) => signal.providerFingerprint) ||
      signals.length === 0 ||
      signals.some((signal) => signal.state !== 'resolved')
    )
      return;
    let recoveryJobId: string | null = null;
    await withTenant(deps.appDb, tenantId, async (tx) => {
      const recovery = await prepareResponseGroupRecoveryTx(tx, tenantId, incidentId);
      if (!recovery) return;
      recoveryJobId = (
        await deps.queue.insertRecoveryTx(
          tx,
          tenantId,
          recovery.rootIncidentId,
          recovery.lifecycleVersion,
          recovery.signalFence,
        )
      ).jobId;
    });
    if (recoveryJobId)
      await deps.queue.publishJob(recoveryJobId).catch((error) =>
        console.warn(
          JSON.stringify({
            level: 'warn',
            app: 'triage-worker',
            event: 'recovery.publish_failed',
            tenantId,
            incidentId,
            jobId: recoveryJobId,
            errorType: error instanceof Error ? error.name : typeof error,
          }),
        ),
      );
  }
}
