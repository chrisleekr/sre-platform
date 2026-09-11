import { redactInput, scrubSecrets } from '@sre/agent-tools';
import {
  hasToolCall,
  latestToolCall,
  loadIncidentEvidence,
  recordToolCall,
  setInterpretation,
  uninterpretedImages,
  type IncidentEvidence,
} from '@sre/db';
import type { Job } from '@sre/queue';
import { interpretImage } from '../engine/interpret-image';
import { measureEvidenceBlock } from '../engine/shared';
import type { IncidentRow, TriageWorkerDeps } from './contracts';
import { triageContextWindowMin } from './presentation';
import type { WorkerRuntime } from './runtime';

/**
 * Reload one incident's durable evidence for a run, budgeted in the unit the prompt actually costs.
 *
 * Every reload path shares this so the two operator-set bounds and the renderer used to size them
 * cannot drift between them: the row ceiling bounds how much is fetched, the character budget
 * decides what survives into the prompt, and sizing by the real renderer keeps the budget honest.
 *
 * @param deps - Worker dependencies supplying the database and the operator-set evidence bounds.
 * @param tenantId - Tenant whose records are read.
 * @param incidentId - Incident whose evidence is reloaded.
 */
export async function reloadIncidentEvidence(
  deps: Pick<TriageWorkerDeps, 'appDb' | 'getEvidenceRowLimit' | 'getEvidenceBudgetChars'>,
  tenantId: string,
  incidentId: string,
): Promise<IncidentEvidence[]> {
  // Both bounds are limits on how much is read, never gates on whether reading happens, so a
  // settings lookup that fails degrades to the module defaults. Every caller wraps this in a catch
  // that drops ALL evidence, so letting a transient settings failure propagate would trade a
  // bounded read for a blank investigation. Fetched together and abandoned together: they share one
  // settings store, so a failure that loses one has almost certainly lost the other, and reporting
  // a single fallback is honest where two independent ones would imply independent causes.
  let limit: number | undefined;
  let budget: number | undefined;
  try {
    [limit, budget] = await Promise.all([
      deps.getEvidenceRowLimit?.(),
      deps.getEvidenceBudgetChars?.(),
    ]);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        app: 'triage-worker',
        event: 'evidence_bounds_unavailable',
        tenantId,
        incidentId,
        // Name plus SQLSTATE, never the message: a postgres.js connection failure's message is
        // `write <errno> <host>:<port>`, which puts the database endpoint in worker stdout. `name`
        // alone is the literal 'Error' for every plain throw, so it cannot tell a corrupt settings
        // row from an outage; `code` is a SQLSTATE, which discriminates and names no endpoint.
        reason: error instanceof Error ? error.name : 'unknown',
        code:
          typeof (error as { code?: unknown })?.code === 'string'
            ? (error as { code: string }).code
            : undefined,
      }),
    );
  }
  // Both bounds pass through undefined when unset: the repository owns each default, and restating
  // either here would let the two copies drift while every test stayed green.
  return loadIncidentEvidence(deps.appDb, tenantId, incidentId, {
    budget,
    measure: measureEvidenceBlock,
    limit,
  });
}

export class WorkerEvidence {
  constructor(private readonly runtime: WorkerRuntime) {}

  async seedFirstPass(tenantId: string, incident: IncidentRow): Promise<IncidentEvidence[]> {
    const { deps } = this.runtime;
    const windowMinutes = triageContextWindowMin();
    const fresherThan = new Date(Date.now() - windowMinutes * 60_000);
    if (await hasToolCall(deps.appDb, tenantId, incident.id, 'fetch_triage_context', fresherThan))
      return this.reloadFirstPass(tenantId, incident);
    const connectors = await deps.connectorProvider(tenantId)();
    if (connectors.length === 0) return [];
    const startedAt = Date.now();
    try {
      const results = await Promise.allSettled(
        connectors.map(async (connector) => ({
          source: connector.type,
          context: await connector.fetchTriageContext({
            service: incident.service,
            windowMinutes,
          }),
        })),
      );
      const raw = {
        sources: results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
        unavailable: results.flatMap((result, index) =>
          result.status === 'rejected' ? [connectors[index]!.type] : [],
        ),
      };
      const output = redactInput(raw);
      const evidenceId = await recordToolCall(deps.appDb, tenantId, {
        incidentId: incident.id,
        tool: 'fetch_triage_context',
        input: { service: incident.service, windowMinutes },
        latencyMs: Date.now() - startedAt,
        outcome: 'data',
        output,
      });
      return [
        {
          id: evidenceId,
          tool: 'fetch_triage_context',
          input: { service: incident.service, windowMinutes },
          output,
          createdAt: new Date(),
        },
      ];
    } catch {
      console.warn(
        JSON.stringify({
          level: 'warn',
          app: 'triage-worker',
          msg: 'first-pass seed failed',
          event: 'firstpass.seed_failed',
          tenantId,
          incidentId: incident.id,
          connectors: connectors.map((connector) => connector.type),
        }),
      );
      return [];
    }
  }

  private async reloadFirstPass(
    tenantId: string,
    incident: IncidentRow,
  ): Promise<IncidentEvidence[]> {
    try {
      const evidence = await latestToolCall(
        this.runtime.deps.appDb,
        tenantId,
        incident.id,
        'fetch_triage_context',
      );
      return evidence === null ? [] : [evidence];
    } catch {
      return [];
    }
  }

  async interpretAttachments(
    job: Job,
    incident: IncidentRow,
    signal: AbortSignal,
  ): Promise<string> {
    const { deps } = this.runtime;
    const { fetchAttachment } = deps;
    const tenantId = job.tenantId;
    if ((!deps.llm && !deps.vision) || !fetchAttachment) return '';
    let pending: Awaited<ReturnType<typeof uninterpretedImages>>;
    try {
      pending = await uninterpretedImages(deps.appDb, tenantId, incident.id);
    } catch {
      return '';
    }
    const lines: string[] = [];
    for (const image of pending) {
      let interpretation: string;
      try {
        const { bytes } = await fetchAttachment(tenantId, image.urlPrivate);
        interpretation = scrubSecrets(
          await this.runtime.executeVision(job, incident.id, signal, (vision) =>
            interpretImage(vision, bytes, image.mimetype, { signal }),
          ),
        );
      } catch {
        if (signal.aborted) throw signal.reason;
        console.warn(
          JSON.stringify({
            level: 'warn',
            app: 'triage-worker',
            msg: 'attachment interpret failed',
            event: 'attachment.interpret_failed',
            tenantId,
            incidentId: incident.id,
            fileId: image.fileId,
          }),
        );
        interpretation = 'Screenshot could not be interpreted automatically.';
      }
      try {
        await setInterpretation(deps.appDb, tenantId, incident.id, image.fileId, interpretation);
      } catch {
        // A later turn retries persistence without blocking the current investigation.
      }
      lines.push(`📎 ${image.name}: ${interpretation}`);
    }
    return lines.length === 0 ? '' : `Human-attached screenshots:\n${lines.join('\n')}`;
  }
}
