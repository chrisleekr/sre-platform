import type { InboundCandidate } from '@sre/connectors';
import type { IncidentSummary } from '@sre/db';
import type { Job } from '@sre/queue';
import {
  resolutionIntentSupported,
  resolutionSelectionSupported,
  resolveBelongsTo,
  resolveSignalSelection,
  type CorrelationVerdict,
} from '../engine/correlation';
import { publicModelText } from '../public-output';
import type { ClassifyAttachments } from './attachments';
import {
  DEGRADED_SEVERITY,
  type AuthorizedResolutionCandidate,
  type ClassifyOutcome,
} from './contracts';
import { ClassifyCore, providerAlertTitle, serviceForChannel } from './core';
import type { ObservationHandler } from './observations';

interface VerdictRoutingInput {
  candidate: InboundCandidate;
  scrubbedCandidate: InboundCandidate;
  job: Job;
  fingerprint: string;
  scrubbedText: string;
  verdict: CorrelationVerdict;
  candidates: IncidentSummary[];
  resolutionCandidates: AuthorizedResolutionCandidate[];
  allResolutionCandidates: AuthorizedResolutionCandidate[];
  enqueueWork: boolean;
  outcome: (value: ClassifyOutcome['outcome']) => Promise<void>;
}

/** Applies one validated correlation verdict to durable incident state. */
export class VerdictRouter {
  constructor(
    private readonly core: ClassifyCore,
    private readonly attachments: ClassifyAttachments,
    private readonly observations: ObservationHandler,
  ) {}

  /** Confirms a recovery selection against server-owned candidates and message identity. */
  recoverySupported(
    verdict: Extract<CorrelationVerdict, { decision: 'resolves_signal' }>,
    message: string,
    candidates: AuthorizedResolutionCandidate[],
    allCandidates: AuthorizedResolutionCandidate[],
  ): boolean {
    const target = resolveSignalSelection(verdict.signalIndex, candidates);
    return Boolean(
      target &&
      resolutionIntentSupported(message) &&
      resolutionSelectionSupported(message, target, allCandidates),
    );
  }

  /** Applies a server-validated verdict without making another model decision. */
  async apply(input: VerdictRoutingInput): Promise<void> {
    const {
      candidate,
      scrubbedCandidate,
      job,
      scrubbedText,
      verdict,
      candidates,
      resolutionCandidates,
      allResolutionCandidates,
      enqueueWork,
      outcome,
    } = input;
    const tenantId = job.tenantId;
    if (verdict.decision === 'resolves_signal') {
      const target = resolveSignalSelection(verdict.signalIndex, resolutionCandidates);
      if (
        !target ||
        !resolutionIntentSupported(scrubbedText) ||
        !resolutionSelectionSupported(scrubbedText, target, allResolutionCandidates)
      )
        throw new Error('unsupported recovery selection reached verdict routing');
      await this.observations.applyResolvedSignal(
        scrubbedCandidate,
        job,
        target,
        scrubbedCandidate.observations?.[0],
      );
      return;
    }
    if (scrubbedCandidate.isEdit) {
      await this.observations.handleEditedSignal(scrubbedCandidate, job);
      return;
    }
    if (verdict.decision === 'not_worthy') {
      if (
        candidate.author === 'bot' &&
        candidate.alertKind === 'firing' &&
        !resolutionIntentSupported(scrubbedText)
      ) {
        await this.openIncident(
          input,
          serviceForChannel(candidate.channel),
          DEGRADED_SEVERITY,
          providerAlertTitle(scrubbedText, scrubbedCandidate.observations),
        );
        await outcome('provider_alert_opened');
        return;
      }
      await outcome('not_worthy');
      return;
    }
    if (verdict.decision === 'belongs_to') {
      const incidentId = resolveBelongsTo(verdict.index, candidates);
      if (incidentId) {
        if (candidate.author === 'bot')
          await this.attachments.attachBot(
            tenantId,
            incidentId,
            scrubbedCandidate,
            scrubbedText,
            enqueueWork,
          );
        else
          await this.attachments.attachHuman(
            tenantId,
            incidentId,
            candidate.channel,
            candidate.externalId,
            scrubbedText,
            undefined,
            enqueueWork,
          );
        await outcome('belongs_to');
        return;
      }
      await this.openIncident(
        input,
        serviceForChannel(candidate.channel),
        DEGRADED_SEVERITY,
        scrubbedText,
      );
      await outcome('new_incident');
      return;
    }
    await this.openIncident(
      input,
      publicModelText(verdict.service),
      verdict.severity,
      publicModelText(verdict.title),
    );
    await outcome('new_incident');
  }

  private async openIncident(
    input: VerdictRoutingInput,
    service: string,
    severity: 'sev1' | 'sev2' | 'sev3',
    title: string,
  ): Promise<void> {
    const { candidate, scrubbedCandidate, job, fingerprint, scrubbedText } = input;
    await this.core.openNewIncident(
      job.tenantId,
      fingerprint,
      { channel: candidate.channel, threadId: candidate.externalId },
      { service, severity, title },
      scrubbedCandidate.raw,
      scrubbedText,
      this.core.openerFor(candidate, scrubbedText),
      this.attachments.foldIntoOwner(job.tenantId, scrubbedCandidate, scrubbedText),
      { signals: this.core.signalsFor(scrubbedCandidate) },
    );
  }
}
