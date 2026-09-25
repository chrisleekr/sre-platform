import type { InboundCandidate } from '@sre/connectors';
import {
  linkSignalDispositionIncident,
  PROVIDER_RECOVERY_REPORT_DECISION,
  PROVIDER_RECOVERY_REPORT_ROOT_DECISION,
} from '@sre/db';
import { RetryableError, type Job } from '@sre/queue';
import { resolutionIntentSupported, type CorrelationVerdict } from '../engine/correlation';
import type { ClassifyAttachments } from './attachments';
import { CLASSIFY_FAIL_OPEN_ATTEMPTS, DEGRADED_SEVERITY, type ClassifyOutcome } from './contracts';
import { ClassifyCore, fingerprintFor, providerAlertTitle, serviceForChannel } from './core';
import { DegradedSignalRouter } from './degraded-routing';
import { RecoveryReports } from './recovery-report';
import { RepeatNotifications } from './repeats';
import { scrubInboundCandidate } from './scrub-candidate';
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
  private readonly degraded: DegradedSignalRouter;
  private readonly verdicts: VerdictRouter;
  private readonly supersession: SupersessionGuard;
  private readonly reports: RecoveryReports;
  private readonly repeats: RepeatNotifications;
  constructor(
    private readonly core: ClassifyCore,
    private readonly attachments: ClassifyAttachments,
  ) {
    this.degraded = new DegradedSignalRouter(core, attachments);
    this.verdicts = new VerdictRouter(core, attachments);
    this.supersession = new SupersessionGuard(core);
    this.reports = new RecoveryReports(core);
    this.repeats = new RepeatNotifications(core);
  }
  async handle(candidate: InboundCandidate, job: Job, signal: AbortSignal): Promise<void> {
    const { deps } = this.core;
    const tenantId = job.tenantId;
    if (signal.aborted) throw signal.reason;
    if (await this.supersession.stop(candidate, job)) return;
    const fingerprint = fingerprintFor(candidate);
    const { scrubbedText, scrubbedCandidate } = scrubInboundCandidate(candidate);
    // Slack presentation is advisory. Native or connector-read evidence uses the provider intake.
    // A recovery notice is linked and shown on its incident, never applied to lifecycle.
    if (scrubbedCandidate.signalState === 'resolved' || scrubbedCandidate.isEdit) {
      let reported: { incidentId: string; signalId: string; scope: 'root' | 'signal' } | null =
        null;
      if (scrubbedCandidate.signalState === 'resolved') {
        const linked = await this.supersession.fenced(candidate, job, () =>
          this.reports.link(tenantId, scrubbedCandidate),
        );
        if (!linked.executed) return;
        reported = linked.value;
      }
      await persistDeterministicDisposition({
        core: this.core,
        candidate,
        scrubbedCandidate,
        job,
        scrubbedText,
        disposition: 'log',
        reason: reported
          ? 'Provider reported recovery in Slack; an operator confirms resolution.'
          : 'Connector verification is required before this notification can change provider lifecycle.',
        ...(reported
          ? {
              correlated: {
                // The scope decides which signals the report covers when the workspace reads it.
                decision:
                  reported.scope === 'root'
                    ? PROVIDER_RECOVERY_REPORT_ROOT_DECISION
                    : PROVIDER_RECOVERY_REPORT_DECISION,
                incidentId: reported.incidentId,
                signalId: reported.signalId,
              },
            }
          : {}),
      });
      await this.outcome(candidate, job, reported ? 'resolution_reported' : 'resolution_unmatched');
      return;
    }
    // A repeat of a tracked monitor is an occurrence of that incident, not a new one. It is
    // attached without a reassessment so it spends no engine run; ambiguity falls through.
    const repeat = await this.repeats.match(tenantId, scrubbedCandidate);
    const attached = repeat
      ? await this.supersession.fenced(candidate, job, () =>
          this.attachments.attachBot(
            tenantId,
            repeat.incidentId,
            scrubbedCandidate,
            scrubbedText,
            false,
            { requireActive: true },
          ),
        )
      : null;
    if (attached && !attached.executed) return;
    // An incident that closed after the match attached nothing, so the repeat is classified afresh.
    if (repeat && attached?.value?.attached) {
      await persistDeterministicDisposition({
        core: this.core,
        candidate,
        scrubbedCandidate,
        job,
        scrubbedText,
        disposition: 'log',
        reason: 'Repeat notification of a monitor already tracked by an open incident.',
        correlated: { decision: 'belongs_to', ...repeat },
      });
      await this.outcome(candidate, job, 'belongs_to');
      return;
    }
    const resolutionCandidates = await this.core.buildResolutionCandidates(
      tenantId,
      scrubbedCandidate,
    );
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
    if (verdict.decision === 'resolves_signal') {
      await persistDeterministicDisposition({
        core: this.core,
        candidate,
        scrubbedCandidate,
        job,
        scrubbedText,
        disposition: 'log',
        reason: 'A model recovery suggestion requires connector verification.',
      });
      await this.outcome(candidate, job, 'resolution_unmatched');
      return;
    }
    if (
      mode === 'enforce' &&
      semantic &&
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
      verdict.decision === 'not_worthy'
    )
      throw new RetryableError('resolution candidates unavailable');
    if (mode === 'shadow')
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
