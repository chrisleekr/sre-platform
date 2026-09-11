import type { InboundCandidate } from '@sre/connectors';
import { linkSignalDispositionIncident, listSignalsByExternalRoot } from '@sre/db';
import { RetryableError, type Job } from '@sre/queue';
import { resolutionIntentSupported, type CorrelationVerdict } from '../engine/correlation';
import {
  correlateGroupedEdit,
  correlateGroupedResolution,
  correlateResolution,
} from '../engine/signal-correlation';
import type { ClassifyAttachments } from './attachments';
import { CLASSIFY_FAIL_OPEN_ATTEMPTS, DEGRADED_SEVERITY, type ClassifyOutcome } from './contracts';
import { ClassifyCore, fingerprintFor, providerAlertTitle, serviceForChannel } from './core';
import { DegradedSignalRouter } from './degraded-routing';
import type { ObservationHandler } from './observations';
import { scrubInboundCandidate } from './scrub-candidate';
import { StructuredFiringRouter } from './structured-routing';
import { SupersessionGuard } from './supersession';
import { VerdictRouter } from './verdict-routing';
import {
  persistDeterministicDisposition,
  persistEffectiveDisposition,
  persistLegacyEffectiveDisposition,
  proposeSemanticDisposition,
  selectSingleCorrelationVerdict,
  shadowSafeCorrelationVerdict,
} from './semantic-routing';
export class PushHandler {
  private readonly structuredFiring: StructuredFiringRouter;
  private readonly degraded: DegradedSignalRouter;
  private readonly verdicts: VerdictRouter;
  private readonly supersession: SupersessionGuard;
  constructor(
    private readonly core: ClassifyCore,
    private readonly attachments: ClassifyAttachments,
    private readonly observations: ObservationHandler,
  ) {
    this.structuredFiring = new StructuredFiringRouter(core, attachments);
    this.degraded = new DegradedSignalRouter(core, attachments, observations);
    this.verdicts = new VerdictRouter(core, attachments, observations);
    this.supersession = new SupersessionGuard(core);
  }

  async handle(candidate: InboundCandidate, job: Job, signal: AbortSignal): Promise<void> {
    const { deps } = this.core;
    const tenantId = job.tenantId;
    if (signal.aborted) throw signal.reason;
    if (await this.supersession.stop(candidate, job)) return;
    const fingerprint = fingerprintFor(candidate);
    const { scrubbedText, scrubbedCandidate } = scrubInboundCandidate(candidate);
    if (
      scrubbedCandidate.isEdit &&
      scrubbedCandidate.signalState === 'resolved' &&
      !scrubbedCandidate.observations?.length
    ) {
      const applied = await this.supersession.fenced(candidate, job, () =>
        this.observations.handleEditedSignal(scrubbedCandidate, job),
      );
      if (!applied.executed) return;
      await persistDeterministicDisposition({
        core: this.core,
        candidate,
        scrubbedCandidate,
        job,
        scrubbedText,
        disposition: 'log',
        reason: 'A provider edit deterministically cleared an existing signal.',
      });
      return;
    }
    if (scrubbedCandidate.isEdit && scrubbedCandidate.observations?.length) {
      const members = await listSignalsByExternalRoot(
        deps.appDb,
        tenantId,
        'slack',
        scrubbedCandidate.channel,
        scrubbedCandidate.externalId,
      );
      if (members.length === 0) {
        if (scrubbedCandidate.observations.length === 1) {
          const legacyCandidate = { ...scrubbedCandidate };
          delete legacyCandidate.observations;
          const applied = await this.supersession.fenced(candidate, job, () =>
            this.observations.handleEditedSignal(legacyCandidate, job),
          );
          if (!applied.executed) return;
          if (!applied.value && scrubbedCandidate.signalState !== 'resolved') {
            await this.degraded.openUntrackedEdit(
              candidate,
              scrubbedCandidate,
              job,
              fingerprint,
              scrubbedText,
            );
            return;
          }
          await persistDeterministicDisposition({
            core: this.core,
            candidate,
            scrubbedCandidate,
            job,
            scrubbedText,
            disposition: scrubbedCandidate.signalState === 'resolved' ? 'log' : 'investigate',
            reason: 'A provider edit deterministically updated an existing signal.',
          });
          return;
        }
        if (await this.core.hasPendingPredecessor(tenantId, scrubbedCandidate))
          throw new RetryableError('edited signal group is not tracked yet');
        await this.outcome(candidate, job, 'edited_untracked');
        if (scrubbedCandidate.signalState !== 'resolved') {
          await this.degraded.openUntrackedEdit(
            candidate,
            scrubbedCandidate,
            job,
            fingerprint,
            scrubbedText,
          );
          return;
        }
        await persistDeterministicDisposition({
          core: this.core,
          candidate,
          scrubbedCandidate,
          job,
          scrubbedText,
          disposition: scrubbedCandidate.signalState === 'resolved' ? 'log' : 'investigate',
          reason: 'An untracked provider edit was retained for operator review.',
        });
        return;
      }
      const matched = correlateGroupedEdit(scrubbedCandidate.observations, members);
      if (!matched) {
        await this.outcome(
          candidate,
          job,
          scrubbedCandidate.signalState === 'resolved'
            ? 'resolution_unmatched'
            : 'edited_untracked',
        );
        if (scrubbedCandidate.signalState !== 'resolved') {
          await this.degraded.openUntrackedEdit(
            candidate,
            scrubbedCandidate,
            job,
            fingerprint,
            scrubbedText,
          );
          return;
        }
        await persistDeterministicDisposition({
          core: this.core,
          candidate,
          scrubbedCandidate,
          job,
          scrubbedText,
          disposition: scrubbedCandidate.signalState === 'resolved' ? 'log' : 'investigate',
          reason: 'An unmatched provider edit was retained for operator review.',
        });
        return;
      }
      const applied = await this.supersession.fenced(candidate, job, () =>
        this.observations.applyObservationGroup(
          scrubbedCandidate,
          job,
          matched.map((index) => members[index]!),
          scrubbedCandidate.observations!,
          'edit',
        ),
      );
      if (!applied.executed) return;
      await persistDeterministicDisposition({
        core: this.core,
        candidate,
        scrubbedCandidate,
        job,
        scrubbedText,
        disposition: scrubbedCandidate.signalState === 'resolved' ? 'log' : 'investigate',
        reason: 'A grouped provider edit deterministically updated existing signals.',
      });
      return;
    }
    const resolutionCandidates = await this.core.buildResolutionCandidates(
      tenantId,
      scrubbedCandidate,
      job.attempts,
    );
    if (scrubbedCandidate.signalState === 'resolved') {
      if (scrubbedCandidate.observations?.length) {
        const grouped = correlateGroupedResolution(
          scrubbedCandidate.observations,
          resolutionCandidates.all,
        );
        if (grouped) {
          const applied = await this.supersession.fenced(candidate, job, () =>
            this.observations.applyObservationGroup(
              scrubbedCandidate,
              job,
              grouped.map((index) => resolutionCandidates.all[index]!),
              scrubbedCandidate.observations!,
              'resolution',
            ),
          );
          if (!applied.executed) return;
          await persistDeterministicDisposition({
            core: this.core,
            candidate,
            scrubbedCandidate,
            job,
            scrubbedText,
            disposition: 'log',
            reason: 'A grouped provider recovery deterministically cleared matched signals.',
          });
          return;
        }
        if (scrubbedCandidate.observations.length > 1) {
          await persistDeterministicDisposition({
            core: this.core,
            candidate,
            scrubbedCandidate,
            job,
            scrubbedText,
            disposition: 'log',
            reason: 'An unmatched grouped recovery was retained without mutating a signal.',
          });
          await this.outcome(candidate, job, 'resolution_unmatched');
          return;
        }
      }
      const exactIndex = correlateResolution(scrubbedText, resolutionCandidates.all);
      const exactTarget = exactIndex === null ? null : resolutionCandidates.all[exactIndex];
      if (exactTarget) {
        const applied = await this.supersession.fenced(candidate, job, () =>
          this.observations.applyResolvedSignal(
            scrubbedCandidate,
            job,
            exactTarget,
            scrubbedCandidate.observations?.[0],
          ),
        );
        if (!applied.executed) return;
        await persistDeterministicDisposition({
          core: this.core,
          candidate,
          scrubbedCandidate,
          job,
          scrubbedText,
          disposition: 'log',
          reason: 'A provider recovery deterministically cleared its matched signal.',
        });
        return;
      }
      if (resolutionCandidates.forModel.length === 0) {
        await persistDeterministicDisposition({
          core: this.core,
          candidate,
          scrubbedCandidate,
          job,
          scrubbedText,
          disposition: 'log',
          reason: 'An unmatched recovery was retained without mutating a signal.',
        });
        await this.outcome(candidate, job, 'resolution_unmatched');
        return;
      }
    }
    const candidates = await this.core.buildCandidates(tenantId, scrubbedText);
    const semanticResult = await proposeSemanticDisposition({
      core: this.core,
      candidate,
      scrubbedCandidate,
      job,
      signal,
      candidates,
      resolutionCandidates: resolutionCandidates.forModel,
      allResolutionCandidates: resolutionCandidates.all,
      scrubbedText,
    });
    if (semanticResult.error) {
      if (deps.semanticDispositionEnabled) {
        await this.supersession.fenced(candidate, job, () =>
          this.degraded.failOpen(
            semanticResult.error,
            candidate,
            scrubbedCandidate,
            job,
            signal,
            fingerprint,
            scrubbedText,
            semanticResult.mode,
          ),
        );
        return;
      }
    }
    let { mode } = semanticResult;
    const { semantic } = semanticResult;
    if (deps.semanticDispositionEnabled && !semantic) {
      await this.supersession.fenced(candidate, job, () =>
        this.degraded.failOpen(
          new Error('semantic classifier unavailable'),
          candidate,
          scrubbedCandidate,
          job,
          signal,
          fingerprint,
          scrubbedText,
          mode,
        ),
      );
      return;
    }
    const fallback = {
      service: serviceForChannel(candidate.channel),
      severity: DEGRADED_SEVERITY,
      title: providerAlertTitle(scrubbedText, scrubbedCandidate.observations),
    } as const;
    if (mode === 'shadow') {
      const handled = await this.structuredFiring.handle(
        candidate,
        scrubbedCandidate,
        job,
        fingerprint,
        scrubbedText,
      );
      if (handled) {
        await persistEffectiveDisposition({
          core: this.core,
          candidate,
          scrubbedCandidate,
          job,
          scrubbedText,
          disposition: 'investigate',
          mode,
          reason: 'Legacy-safe structured provider routing opened an investigation.',
        });
        return;
      }
    }
    let verdict: CorrelationVerdict;
    try {
      verdict = await selectSingleCorrelationVerdict(semantic, fallback, () =>
        deps.llm
          ? deps.llm.execute(
              { tenantId, jobId: job.id, operation: 'classify', signal },
              ({ classifier }) =>
                classifier.classify(scrubbedCandidate, candidates, resolutionCandidates.forModel),
            )
          : deps.classify!.classify(scrubbedCandidate, candidates, resolutionCandidates.forModel, {
              signal,
            }),
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (await this.supersession.stop(candidate, job)) return;
      await this.supersession.fenced(candidate, job, () =>
        this.degraded.failOpen(
          error,
          candidate,
          scrubbedCandidate,
          job,
          signal,
          fingerprint,
          scrubbedText,
          mode,
        ),
      );
      return;
    }
    if (mode === 'shadow' && semantic) {
      verdict = shadowSafeCorrelationVerdict(semantic, verdict, fallback);
    }
    if (
      verdict.decision === 'resolves_signal' &&
      !this.verdicts.recoverySupported(
        verdict,
        scrubbedText,
        resolutionCandidates.forModel,
        resolutionCandidates.all,
      )
    ) {
      await this.supersession.fenced(candidate, job, () =>
        this.degraded.failOpen(
          new Error('classifier selected an unsupported recovery target'),
          candidate,
          scrubbedCandidate,
          job,
          signal,
          fingerprint,
          scrubbedText,
          mode,
        ),
      );
      return;
    }
    if (
      mode === 'enforce' &&
      semantic &&
      verdict.decision !== 'resolves_signal' &&
      verdict.decision !== 'belongs_to' &&
      (semantic.disposition === 'ticket' || semantic.disposition === 'log')
    ) {
      const suppressed = await this.supersession.fenced(candidate, job, async () => {
        const authorized = await persistEffectiveDisposition({
          core: this.core,
          candidate,
          scrubbedCandidate,
          job,
          scrubbedText,
          disposition: semantic.disposition,
          mode,
          reason: semantic.reason,
          requireCurrentApproval: true,
        });
        if (!authorized) return false;
        await this.outcome(candidate, job, semantic.disposition);
        return true;
      });
      if (!suppressed.executed || suppressed.value) return;
      mode = 'shadow';
      verdict = shadowSafeCorrelationVerdict(semantic, verdict, fallback);
    }
    if (await this.supersession.stop(candidate, job)) return;
    if (
      resolutionCandidates.lookupFailed &&
      job.attempts < CLASSIFY_FAIL_OPEN_ATTEMPTS &&
      (verdict.decision === 'not_worthy' || verdict.decision === 'resolves_signal')
    )
      throw new RetryableError('resolution candidates unavailable');
    if (mode === 'shadow') {
      await persistLegacyEffectiveDisposition({
        core: this.core,
        candidate,
        scrubbedCandidate,
        job,
        scrubbedText,
        mode,
        decision: verdict.decision,
        hasResolutionIntent: resolutionIntentSupported(scrubbedText),
      });
    }
    const applied = await this.supersession.fenced(candidate, job, () =>
      this.verdicts.apply({
        candidate,
        scrubbedCandidate,
        job,
        fingerprint,
        scrubbedText,
        verdict,
        candidates,
        resolutionCandidates: resolutionCandidates.forModel,
        allResolutionCandidates: resolutionCandidates.all,
        enqueueWork: mode === 'shadow' || semantic?.disposition === 'investigate',
        outcome: (value) => this.outcome(candidate, job, value),
      }),
    );
    if (
      applied.executed &&
      semantic?.decision === 'belongs_to' &&
      semantic.index &&
      candidates[semantic.index - 1]
    ) {
      await linkSignalDispositionIncident(
        deps.appDb,
        tenantId,
        candidate.author === 'bot' ? 'slack-provider' : 'slack-human',
        candidate.eventKey,
        candidates[semantic.index - 1]!.id,
      );
    }
    if (applied.executed && mode === 'enforce' && semantic) {
      await persistEffectiveDisposition({
        core: this.core,
        candidate,
        scrubbedCandidate,
        job,
        scrubbedText,
        disposition: semantic.disposition,
        mode,
        reason: semantic.reason,
      });
    }
  }

  private async outcome(
    candidate: InboundCandidate,
    job: Job,
    outcome: ClassifyOutcome['outcome'],
  ): Promise<void> {
    await this.core.emitOutcome({
      intakeId: candidate.intakeId,
      tenantId: job.tenantId,
      channel: candidate.channel,
      messageId: candidate.externalId,
      author: candidate.author,
      outcome,
      attempts: job.attempts,
    });
  }
}
