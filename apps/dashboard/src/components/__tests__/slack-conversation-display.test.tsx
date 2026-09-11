// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConversationLog } from '../incident-conversation/timeline';

test('shows resolved Slack names without rendering raw IDs or profile markup as HTML', () => {
  render(
    <ConversationLog
      messages={[
        {
          id: 'message',
          incidentId: 'incident',
          author: 'human',
          kind: 'reply',
          originSurface: 'slack',
          content: '[U111]: <@U222> check health',
          displayContent: 'Chris: @Homelab check health',
          authorDisplayName: 'Chris',
          createdAt: '2026-09-10T04:51:39.000Z',
        },
      ]}
    />,
  );
  expect(screen.getByText('Chris')).toBeDefined();
  expect(screen.getByText('Chris: @Homelab check health')).toBeDefined();
  expect(screen.queryByText(/U111|U222/)).toBeNull();
});
