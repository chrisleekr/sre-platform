// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { IssueActionView } from '@sre/contracts';
import { IssueActionCard } from '../IssueActionCard';

test('saved previews distinguish identical repository paths on separate instances', () => {
  const action: IssueActionView = {
    id: 'draft-one',
    connectorId: 'connection-one',
    repository: 'team/service',
    destination: {
      connectionName: 'Production GitLab',
      provider: 'gitlab',
      repositoryUrl: 'https://gitlab.example.com/team/service',
    },
    requestedBy: 'requester',
    status: 'draft',
    changes: { title: 'Follow-up' },
    expiresAt: '2026-09-13T12:00:00Z',
    before: null,
    result: null,
    error: null,
    canConfirm: true,
  };
  render(
    <>
      <IssueActionCard action={action} busy={false} onDecision={() => {}} />
      <IssueActionCard
        action={{
          ...action,
          id: 'draft-two',
          connectorId: 'connection-two',
          destination: {
            connectionName: 'Test GitLab',
            provider: 'gitlab',
            repositoryUrl: 'https://test-gitlab.example.com/team/service',
          },
        }}
        busy={false}
        onDecision={() => {}}
      />
    </>,
  );
  const cards = screen.getAllByRole('article');
  expect(within(cards[0]!).getByText('Production GitLab · gitlab')).toBeTruthy();
  expect(within(cards[0]!).getByText(action.destination.repositoryUrl)).toBeTruthy();
  expect(within(cards[1]!).getByText('Test GitLab · gitlab')).toBeTruthy();
  expect(within(cards[1]!).getByText('https://test-gitlab.example.com/team/service')).toBeTruthy();
});
