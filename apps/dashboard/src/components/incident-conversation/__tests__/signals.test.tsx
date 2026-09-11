// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import type { IncidentWorkspaceData } from '../../../lib/types';
import { SignalOverview } from '../signals';

test('explains why an episode grouped and when automatic grouping must stop', () => {
  render(
    <SignalOverview
      workspace={
        {
          incident: { alertSource: 'prometheus' },
          signals: [
            {
              id: 'signal-1',
              surface: 'slack',
              channel: 'C-ALERTS',
              externalMessageId: 'episode-1',
              state: 'firing',
              lastEventType: 'opened',
              summary: 'Checkout latency',
              version: 1,
              firstSeenAt: '2026-08-31T00:00:00.000Z',
              lastSeenAt: '2026-08-31T00:00:00.000Z',
              resolvedAt: null,
              correlationMethod: 'stable_subject_window',
              correlationRationale:
                'The stable monitor matched an active incident inside both time bounds.',
              correlationFeatures: ['stable_subject_identity', 'inside_rolling_window'],
              correlationConfidence: 100,
              correlationWindowStartedAt: '2026-08-31T00:00:00.000Z',
              correlationWindowExpiresAt: '2026-08-31T00:05:00.000Z',
              correlationMaxAgeAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        } as IncidentWorkspaceData
      }
    />,
  );

  expect(screen.getByText(/Grouped into this incident · 100% policy match/)).toBeDefined();
  expect(
    screen.getByText('The stable monitor matched an active incident inside both time bounds.'),
  ).toBeDefined();
  expect(screen.getByText(/Rolling window ends/)).toBeDefined();
  expect(screen.getByText(/Hard incident-age stop/)).toBeDefined();
});
