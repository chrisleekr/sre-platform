import type { DurableSignalContext } from './signal-disposition';

export interface SignalContextInput {
  signalId: string;
  jobId: string;
  summary: string;
  author: 'bot' | 'human';
  signalState: string;
  providerGroupKey: string | null;
  correlationCandidates?: DurableSignalContext['correlationCandidates'];
  resolutionCandidates?: DurableSignalContext['resolutionCandidates'];
}

/** Projects live and evaluation inputs into the exact durable classifier context. */
export function projectDurableSignalContext(input: SignalContextInput): DurableSignalContext {
  const provider = input.author === 'bot';
  return {
    signalId: input.signalId,
    jobId: input.jobId,
    summary: input.summary,
    source: provider ? 'slack-provider' : 'slack-human',
    author: provider ? 'provider' : 'human',
    service: input.providerGroupKey,
    signalState: input.signalState,
    correlationCandidates: input.correlationCandidates,
    resolutionCandidates: input.resolutionCandidates,
  };
}
