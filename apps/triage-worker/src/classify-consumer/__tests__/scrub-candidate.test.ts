import { describe, expect, test } from 'vitest';
import { scrubInboundCandidate } from '../scrub-candidate';

describe('semantic candidate scrubbing', () => {
  test('redacts every free-form observation field before model and storage use', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const { scrubbedCandidate } = scrubInboundCandidate({
      externalId: '1800000000.000100',
      channel: 'C1',
      author: 'bot',
      text: `Alert ${secret}`,
      raw: { token: secret },
      signalState: 'firing',
      alertKind: 'firing',
      eventKey: 'event-1',
      eventAt: '2026-09-02T00:00:00.000Z',
      contentHash: 'raw',
      isEdit: false,
      observations: [
        {
          externalMessageId: '1800000000.000100',
          state: 'firing',
          summary: `Summary ${secret}`,
          contentHash: 'raw-observation',
          eventKey: 'event-1:observation',
          eventAt: '2026-09-02T00:00:00.000Z',
          provider: `provider-${secret}`,
          providerGroupKey: `alertmanager:${secret}`,
          alertName: `Database ${secret}`,
        },
      ],
    });

    expect(JSON.stringify(scrubbedCandidate)).not.toContain(secret);
    expect(JSON.stringify(scrubbedCandidate)).toContain('[REDACTED]');
  });
});
