import type { InboundCandidate } from '@sre/connectors';
import { scrubSecrets } from '@sre/agent-tools';
import {
  findSignalDispositionBySourceEvent,
  getIncident,
  getSignalResolutionCandidate,
  getTenantSignalPolicy,
  effectiveSignalClassificationMode,
  markSignalEffectiveDisposition,
  markSignalEffectiveDispositionIfApproved,
  PROVIDER_RECOVERY_REPORT_DECISION,
  PROVIDER_RECOVERY_REPORT_ROOT_DECISION,
  recordSignalDisposition,
  type IncidentSummary,
  type SignalDisposition,
} from '@sre/db';
import {
  SEMANTIC_DISPOSITION_CONTRACT_VERSION,
  SIGNAL_DISPOSITION_CORPUS_VERSION,
} from '@sre/contracts';
import type { Job } from '@sre/queue';
import {
  classifyDurableSignal,
  semanticDispositionSchema,
  type SemanticDisposition,
} from '../engine/signal-disposition';
import type { CorrelationVerdict, ResolutionCandidate } from '../engine/correlation';
import type { ClassifyCore } from './core';
import { projectDurableSignalContext } from '../engine/signal-context';

type PersistedDisposition = NonNullable<
  Awaited<ReturnType<typeof findSignalDispositionBySourceEvent>>
>;

function semanticSource(candidate: InboundCandidate): 'slack-provider' | 'slack-human' {
  return candidate.author === 'bot' ? 'slack-provider' : 'slack-human';
}

/** Rebuilds the exact durable model result while resolving opaque target IDs to current indexes. */
export function replaySemanticDisposition(
  row: PersistedDisposition,
  candidates: IncidentSummary[],
  resolutionCandidates: ResolutionCandidate[],
): SemanticDisposition {
  let routing:
    | { decision: 'standalone' | 'new_incident' }
    | { decision: 'belongs_to'; index: number }
    | { decision: 'resolves_signal'; signalIndex: number };
  if (row.correlationDecision === 'belongs_to') {
    const index = candidates.findIndex((candidate) => candidate.id === row.correlatedIncidentId);
    if (index < 0) throw new Error('persisted incident correlation target is unavailable');
    routing = { decision: 'belongs_to', index: index + 1 };
  } else if (row.correlationDecision === 'resolves_signal') {
    const index = resolutionCandidates.findIndex(
      (candidate) => candidate.id === row.correlatedSignalId,
    );
    if (index < 0) throw new Error('persisted recovery target is unavailable');
    routing = { decision: 'resolves_signal', signalIndex: index + 1 };
  } else if (
    row.correlationDecision === 'standalone' ||
    row.correlationDecision === 'new_incident'
  ) {
    routing = { decision: row.correlationDecision };
  } else {
    throw new Error('persisted semantic routing decision is invalid');
  }

  const common = {
    disposition: row.disposition,
    reason: row.reason,
    ...(row.service ? { service: row.service } : {}),
    ...(row.severity === 'sev1' || row.severity === 'sev2' || row.severity === 'sev3'
      ? { severity: row.severity }
      : {}),
    ...(row.proposedTitle ? { title: row.proposedTitle } : {}),
    ...routing,
  };
  return semanticDispositionSchema.parse(
    row.disposition === 'ticket'
      ? {
          ...common,
          disposition: 'ticket',
          action: row.action,
          safeDeferralReason: row.safeDeferralReason,
          riskIfIgnored: row.riskIfIgnored,
          reviewHorizonMinutes: row.reviewHorizonMinutes,
        }
      : common,
  );
}

async function currentSignalClassificationMode(
  core: ClassifyCore,
  tenantId: string,
): Promise<'shadow' | 'enforce'> {
  if (!core.deps.semanticDispositionEnabled) return 'shadow';
  const policy = await getTenantSignalPolicy(core.deps.appDb, tenantId);
  if (policy.classificationMode !== 'enforce') return 'shadow';
  const runtimeFingerprint = await core.deps.llm?.configurationFingerprint?.();
  return runtimeFingerprint
    ? effectiveSignalClassificationMode(policy, runtimeFingerprint)
    : 'shadow';
}

/** Runs and persists one scrubbed semantic proposal when the composition enables it. */
export async function proposeSemanticDisposition(input: {
  core: ClassifyCore;
  candidate: InboundCandidate;
  scrubbedCandidate: InboundCandidate;
  job: Job;
  signal: AbortSignal;
  candidates: IncidentSummary[];
  resolutionCandidates: ResolutionCandidate[];
  allResolutionCandidates: ResolutionCandidate[];
  scrubbedText: string;
}): Promise<{
  mode: 'shadow' | 'enforce';
  semantic: SemanticDisposition | null;
  error?: unknown;
}> {
  const {
    core,
    candidate,
    scrubbedCandidate,
    job,
    signal,
    candidates,
    resolutionCandidates,
    allResolutionCandidates,
    scrubbedText,
  } = input;
  const { deps } = core;
  if (signal.aborted) throw signal.reason;
  let policy: Awaited<ReturnType<typeof getTenantSignalPolicy>> | { classificationMode: 'shadow' };
  try {
    policy = deps.semanticDispositionEnabled
      ? await getTenantSignalPolicy(deps.appDb, job.tenantId)
      : { classificationMode: 'shadow' as const };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { mode: 'shadow', semantic: null, error };
  }
  let mode = policy.classificationMode ?? 'shadow';
  let expectedConfigurationFingerprint: string | undefined;
  const runtimeFingerprint =
    (await deps.llm?.configurationFingerprint?.().catch(() => {
      if (signal.aborted) throw signal.reason;
      return null;
    })) ?? null;
  if (mode === 'enforce') {
    mode = runtimeFingerprint
      ? effectiveSignalClassificationMode(policy, runtimeFingerprint)
      : 'shadow';
    if (mode === 'enforce') expectedConfigurationFingerprint = runtimeFingerprint ?? undefined;
  }
  if (!deps.semanticDispositionEnabled) return { mode, semantic: null };
  const source = semanticSource(candidate);
  try {
    const existing = await findSignalDispositionBySourceEvent(
      deps.appDb,
      job.tenantId,
      source,
      candidate.eventKey,
    );
    if (existing) {
      if (
        existing.correlationDecision === 'belongs_to' &&
        existing.correlatedIncidentId &&
        !candidates.some((item) => item.id === existing.correlatedIncidentId)
      ) {
        const incident = await getIncident(deps.appDb, job.tenantId, existing.correlatedIncidentId);
        if (incident && !incident.archivedAt && ['open', 'mitigated'].includes(incident.status))
          candidates.push(incident);
      }
      if (
        existing.correlationDecision === 'resolves_signal' &&
        existing.correlatedSignalId &&
        !resolutionCandidates.some((item) => item.id === existing.correlatedSignalId)
      ) {
        const target = await getSignalResolutionCandidate(
          deps.appDb,
          job.tenantId,
          existing.correlatedSignalId,
        );
        if (target) {
          resolutionCandidates.push(target);
          if (!allResolutionCandidates.some((item) => item.id === target.id))
            allResolutionCandidates.push(target);
        }
      }
      const replayMode =
        mode === 'enforce' &&
        existing.classificationMode === 'enforce' &&
        existing.runtimeFingerprint === runtimeFingerprint &&
        existing.corpusVersion === SIGNAL_DISPOSITION_CORPUS_VERSION &&
        existing.contractVersion === SEMANTIC_DISPOSITION_CONTRACT_VERSION
          ? 'enforce'
          : 'shadow';
      return {
        mode: replayMode,
        semantic: replaySemanticDisposition(existing, candidates, resolutionCandidates),
      };
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { mode, semantic: null, error };
  }
  const classify = (generator: NonNullable<typeof deps.generator>) =>
    classifyDurableSignal(
      projectDurableSignalContext({
        signalId: candidate.eventKey,
        jobId: job.id,
        summary: scrubbedText,
        author: candidate.author,
        providerGroupKey: scrubbedCandidate.observations?.[0]?.providerGroupKey ?? null,
        signalState: candidate.signalState,
        correlationCandidates: candidates.map((item, index) => ({
          index: index + 1,
          title: scrubSecrets(item.title ?? item.service),
          service: scrubSecrets(item.service),
        })),
        resolutionCandidates: resolutionCandidates.map((item, index) => ({
          index: index + 1,
          title: scrubSecrets(item.title ?? item.service),
          service: scrubSecrets(item.service),
          summary: scrubSecrets(item.summary),
        })),
      }),
      {
        generate: (request, system) =>
          generator.generate(JSON.stringify(request), semanticDispositionSchema, {
            system,
            signal,
          }),
      },
    );
  let semantic: SemanticDisposition | null;
  try {
    semantic = deps.llm
      ? await deps.llm.execute(
          {
            tenantId: job.tenantId,
            jobId: job.id,
            operation: 'classify',
            expectedConfigurationFingerprint,
            signal,
          },
          ({ generator }) => classify(generator),
        )
      : deps.generator
        ? await classify(deps.generator)
        : null;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { mode, semantic: null, error };
  }
  if (!semantic) return { mode, semantic };
  try {
    const correlatedIncidentId =
      semantic.decision === 'belongs_to' && semantic.index
        ? candidates[semantic.index - 1]?.id
        : null;
    const correlatedSignalId =
      semantic.decision === 'resolves_signal' && semantic.signalIndex
        ? resolutionCandidates[semantic.signalIndex - 1]?.id
        : null;
    if (semantic.decision === 'belongs_to' && !correlatedIncidentId) {
      throw new Error('classifier selected an unavailable incident target');
    }
    if (semantic.decision === 'resolves_signal' && !correlatedSignalId) {
      throw new Error('classifier selected an unavailable recovery target');
    }
    const persisted = await recordSignalDisposition(deps.appDb, job.tenantId, {
      source,
      sourceEventKey: candidate.eventKey,
      sourceEventAt: new Date(candidate.eventAt),
      sourceEventVersion: candidate.eventVersion ?? null,
      signalKey:
        scrubbedCandidate.observations?.[0]?.monitorKey ??
        `slack:${candidate.channel}:${candidate.externalId}`,
      surface: 'slack',
      channel: candidate.channel,
      threadId: candidate.externalId,
      summary: scrubbedText,
      reason: semantic.reason,
      service: semantic.service ?? null,
      severity: semantic.severity ?? null,
      proposedTitle: semantic.title ?? null,
      disposition: semantic.disposition,
      classificationMode: mode,
      runtimeFingerprint,
      corpusVersion: SIGNAL_DISPOSITION_CORPUS_VERSION,
      contractVersion: SEMANTIC_DISPOSITION_CONTRACT_VERSION,
      effectiveDisposition: null,
      correlationDecision: semantic.decision,
      correlatedIncidentId,
      correlatedSignalId,
      ticket:
        semantic.disposition === 'ticket'
          ? {
              action: semantic.action,
              safeDeferralReason: semantic.safeDeferralReason,
              riskIfIgnored: semantic.riskIfIgnored,
              reviewHorizonMinutes: semantic.reviewHorizonMinutes,
            }
          : null,
    });
    semantic = replaySemanticDisposition(persisted, candidates, resolutionCandidates);
    mode =
      mode === 'enforce' &&
      persisted.classificationMode === 'enforce' &&
      persisted.runtimeFingerprint === runtimeFingerprint &&
      persisted.corpusVersion === SIGNAL_DISPOSITION_CORPUS_VERSION &&
      persisted.contractVersion === SEMANTIC_DISPOSITION_CONTRACT_VERSION
        ? 'enforce'
        : 'shadow';
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { mode, semantic: null, error };
  }
  return { mode, semantic };
}

/** Converts the single semantic result into the existing incident-correlation control shape. */
export function semanticCorrelationVerdict(
  semantic: SemanticDisposition,
  fallback: { service: string; severity: 'sev3'; title: string },
): CorrelationVerdict {
  if (semantic.decision === 'resolves_signal' && semantic.signalIndex) {
    return { decision: 'resolves_signal', signalIndex: semantic.signalIndex };
  }
  if (semantic.decision === 'belongs_to' && semantic.index) {
    return { decision: 'belongs_to', index: semantic.index };
  }
  if (semantic.disposition !== 'investigate') return { decision: 'not_worthy' };
  return {
    decision: 'new_incident',
    service: semantic.service ?? fallback.service,
    severity: semantic.severity ?? fallback.severity,
    title: semantic.title ?? fallback.title,
  };
}

/** Guarantees that a semantic result never triggers a second classifier decision. */
export function selectSingleCorrelationVerdict(
  semantic: SemanticDisposition | null,
  fallback: { service: string; severity: 'sev3'; title: string },
  classifyLegacy: () => Promise<CorrelationVerdict>,
): Promise<CorrelationVerdict> {
  return semantic
    ? Promise.resolve(semanticCorrelationVerdict(semantic, fallback))
    : classifyLegacy();
}

/** Keeps a shadow proposal observable without letting it suppress conservative routing. */
export function shadowSafeCorrelationVerdict(
  semantic: SemanticDisposition,
  verdict: CorrelationVerdict,
  fallback: { service: string; severity: 'sev3'; title: string },
): CorrelationVerdict {
  return semantic.disposition !== 'investigate' && verdict.decision === 'not_worthy'
    ? { decision: 'new_incident', ...fallback }
    : verdict;
}

/** Deterministic link from one inbound event to the incident signal it was matched to. */
export interface DeterministicCorrelation {
  /** `belongs_to` for an attached repeat; a `recovery_reported` variant for an advisory Slack recovery. */
  decision:
    | 'belongs_to'
    | typeof PROVIDER_RECOVERY_REPORT_DECISION
    | typeof PROVIDER_RECOVERY_REPORT_ROOT_DECISION;
  incidentId: string;
  signalId: string;
}

/** Persists the effective shadow decision or a fail-open terminal disposition. */
export async function persistEffectiveDisposition(input: {
  core: ClassifyCore;
  candidate: InboundCandidate;
  scrubbedCandidate: InboundCandidate;
  job: Job;
  scrubbedText: string;
  disposition: SignalDisposition;
  mode: 'shadow' | 'enforce';
  reason: string;
  requireCurrentApproval?: boolean;
  correlated?: DeterministicCorrelation;
}): Promise<boolean> {
  const { deps } = input.core;
  if (!deps.semanticDispositionEnabled) return false;
  const source = input.candidate.author === 'bot' ? 'slack-provider' : 'slack-human';
  const existing = input.requireCurrentApproval
    ? input.disposition === 'ticket' || input.disposition === 'log'
      ? await markSignalEffectiveDispositionIfApproved(
          deps.appDb,
          input.job.tenantId,
          source,
          input.candidate.eventKey,
          input.disposition,
        )
      : null
    : await markSignalEffectiveDisposition(
        deps.appDb,
        input.job.tenantId,
        source,
        input.candidate.eventKey,
        input.disposition,
      );
  if (existing) return true;
  if (input.requireCurrentApproval) return false;
  await recordSignalDisposition(deps.appDb, input.job.tenantId, {
    source,
    sourceEventKey: input.candidate.eventKey,
    sourceEventAt: new Date(input.candidate.eventAt),
    sourceEventVersion: input.candidate.eventVersion ?? null,
    signalKey:
      input.scrubbedCandidate.observations?.[0]?.monitorKey ??
      `slack:${input.candidate.channel}:${input.candidate.externalId}`,
    surface: 'slack',
    channel: input.candidate.channel,
    threadId: input.candidate.externalId,
    summary: input.scrubbedText,
    reason: input.reason,
    service: input.scrubbedCandidate.observations?.[0]?.providerGroupKey ?? null,
    disposition: input.disposition,
    classificationMode: input.mode,
    effectiveDisposition: input.disposition,
    ...(input.correlated
      ? {
          correlationDecision: input.correlated.decision,
          correlatedIncidentId: input.correlated.incidentId,
          correlatedSignalId: input.correlated.signalId,
        }
      : {}),
    ticket: null,
  });
  return true;
}

/** Persists a deterministic control event without spending a second model decision. */
export async function persistDeterministicDisposition(input: {
  core: ClassifyCore;
  candidate: InboundCandidate;
  scrubbedCandidate: InboundCandidate;
  job: Job;
  scrubbedText: string;
  disposition: SignalDisposition;
  reason: string;
  correlated?: DeterministicCorrelation;
}): Promise<void> {
  let mode: 'shadow' | 'enforce' = 'shadow';
  try {
    mode = await currentSignalClassificationMode(input.core, input.job.tenantId);
  } catch {
    mode = 'shadow';
  }
  await persistEffectiveDisposition({ ...input, mode });
}

/** Maps legacy-safe routing into the disposition that actually controlled work. */
function legacyEffectiveDisposition(input: {
  candidate: InboundCandidate;
  scrubbedCandidate: InboundCandidate;
  decision: string;
  hasResolutionIntent: boolean;
}): SignalDisposition {
  if (input.scrubbedCandidate.isEdit || input.decision === 'resolves_signal') return 'log';
  if (input.decision !== 'not_worthy') return 'investigate';
  return input.candidate.author === 'bot' &&
    input.candidate.alertKind === 'firing' &&
    !input.hasResolutionIntent
    ? 'investigate'
    : 'log';
}

/** Persists the legacy-safe decision selected during semantic shadow evaluation. */
export function persistLegacyEffectiveDisposition(input: {
  core: ClassifyCore;
  candidate: InboundCandidate;
  scrubbedCandidate: InboundCandidate;
  job: Job;
  scrubbedText: string;
  mode: 'shadow';
  decision: string;
  hasResolutionIntent: boolean;
}) {
  return persistEffectiveDisposition({
    core: input.core,
    candidate: input.candidate,
    scrubbedCandidate: input.scrubbedCandidate,
    job: input.job,
    scrubbedText: input.scrubbedText,
    disposition: legacyEffectiveDisposition(input),
    mode: input.mode,
    reason: 'Legacy-safe routing decision retained during semantic shadow evaluation.',
  });
}
