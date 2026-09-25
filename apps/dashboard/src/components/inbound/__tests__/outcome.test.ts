import { expect, test } from 'vitest';
import { inboundOutcomePresentation } from '../outcome';

test('a linked Slack recovery notice presents as a reported recovery, not a resolution', () => {
  const presented = inboundOutcomePresentation({
    state: 'processed',
    outcome: 'classify_enqueued',
    classificationOutcome: 'resolution_reported',
    classificationUpdatedAt: '2026-09-20T00:05:01Z',
    terminalDisposition: 'resolution_reported',
    acceptedAt: '2026-09-20T00:05:00Z',
    completedAt: '2026-09-20T00:05:01Z',
    jobStatus: 'completed',
    attemptCount: 1,
    errorCode: null,
  });

  expect(presented).toEqual({
    label: 'Recovery reported',
    detail:
      'Linked to its incident without changing any alert. An operator confirms resolution from the incident.',
    tone: 'neutral',
  });
});
