import { redactInput, scrubSecrets } from '@sre/agent-tools';
import type { InboundCandidate } from '@sre/connectors';
import { createHash } from 'node:crypto';

/** Removes secrets from every free-form field before model or persistence use. */
export function scrubInboundCandidate(candidate: InboundCandidate): {
  scrubbedCandidate: InboundCandidate;
  scrubbedText: string;
} {
  const scrubbedText = scrubSecrets(candidate.text);
  return {
    scrubbedText,
    scrubbedCandidate: {
      ...candidate,
      text: scrubbedText,
      raw: redactInput(candidate.raw),
      contentHash: createHash('sha256').update(scrubbedText).digest('hex'),
      ...(candidate.observations
        ? {
            observations: candidate.observations.map((observation) => {
              const summary = scrubSecrets(observation.summary);
              const optional = (value?: string) => {
                const scrubbed = value ? scrubSecrets(value).trim() : '';
                return scrubbed || undefined;
              };
              return {
                externalMessageId: observation.externalMessageId,
                state: observation.state,
                summary,
                eventKey: observation.eventKey,
                eventVersion: observation.eventVersion,
                eventAt: observation.eventAt,
                provider: optional(observation.provider),
                providerGroupKey: optional(observation.providerGroupKey),
                monitorKey: optional(observation.monitorKey),
                alertName: optional(observation.alertName),
                contentHash: createHash('sha256').update(summary).digest('hex'),
                materialHash: observation.materialHash,
              };
            }),
          }
        : {}),
    },
  };
}
