// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitLabManagementPanel } from '../gitlab-connect/ManagementPanel';
import type {
  GitLabManagementApi,
  GitLabManagementStatus,
} from '../../lib/connector-api/gitlab-management';

afterEach(cleanup);
const inactive: GitLabManagementStatus = {
  authorized: false,
  approvedAt: null,
  catalogCheckedAt: null,
  failureCategory: null,
  counts: { covered: 0, missing: 0, pending: 1, failed: 0, total: 1 },
  projects: [],
};
function api(): GitLabManagementApi {
  return {
    status: vi.fn(async () => inactive),
    preview: vi.fn(async () => ({
      reviewDigest: 'digest',
      receiver: 'https://api.example.com/webhooks/gitlab/one',
      knownProjects: 1,
      projects: [
        { project: 'platform/service', recordedHookId: null, action: 'inspect_or_create' as const },
      ],
      scope: {
        baseUrl: 'https://gitlab.example.com',
        groupPath: 'platform',
        events: { push_events: true },
      },
      effect: 'Maintain only owned hooks, including future projects.',
    })),
    authorize: vi.fn(async () => ({})),
    revoke: vi.fn(async () => ({})),
  };
}

test('requires a scoped review, separate token and explicit approval without rendering the stored credential', async () => {
  const calls = api();
  render(
    <GitLabManagementPanel
      api={calls}
      connectorId="one"
      destination="https://api.example.com/webhooks/gitlab/one"
    />,
  );
  await screen.findByText(/Management not authorized/);
  fireEvent.click(screen.getByRole('button', { name: 'Review management scope' }));
  await screen.findByText('platform');
  expect(screen.getByText(/Planned project actions \(1 of 1 known projects\)/)).toBeDefined();
  expect(screen.getByText(/not a live GitLab diff/)).toBeDefined();
  expect(screen.getByText(/create only when no owned hook is found/)).toBeDefined();
  const button = screen.getByRole('button', {
    name: 'Authorize automatic hooks',
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Management access token'), {
    target: { value: 'write-token' },
  });
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() =>
    expect(calls.authorize).toHaveBeenCalledWith('one', {
      destination: 'https://api.example.com/webhooks/gitlab/one',
      reviewDigest: 'digest',
      managementToken: 'write-token',
      approved: true,
    }),
  );
  await screen.findByRole('status');
  expect(screen.queryByLabelText('Management access token')).toBeNull();
  expect(screen.getByText(/verify incoming events separately/)).toBeDefined();
});

test('exposes uncertain creation and an explicit stop action without claiming hook deletion', async () => {
  const calls = api();
  vi.mocked(calls.status).mockResolvedValue({
    ...inactive,
    authorized: true,
    projects: [
      {
        project: 'platform/service',
        hookId: null,
        failureCategory: 'creation_uncertain',
        lastCheckedAt: null,
      },
    ],
  });
  render(
    <GitLabManagementPanel
      api={calls}
      connectorId="one"
      destination="https://api.example.com/webhooks/gitlab/one"
    />,
  );
  await screen.findByText(/will not create a duplicate/);
  fireEvent.click(screen.getByRole('button', { name: 'Stop management' }));
  await waitFor(() => expect(calls.revoke).toHaveBeenCalledWith('one'));
  await screen.findByText('Management stopped. Existing GitLab hooks were not removed.');
});

test('requires a separate absence confirmation for an uncertain creation retry', async () => {
  const calls = api();
  const review = await calls.preview('one', 'https://api.example.com/webhooks/gitlab/one');
  const recovery = {
    recordId: 'record',
    ownershipId: 'ownership',
    attemptedAt: '2026-09-09T00:00:00.000Z',
  };
  vi.mocked(calls.preview).mockResolvedValue({
    ...review,
    projects: [{ project: 'platform/service', recordedHookId: null, action: 'recover', recovery }],
  });
  render(
    <GitLabManagementPanel
      api={calls}
      connectorId="one"
      destination="https://api.example.com/webhooks/gitlab/one"
    />,
  );
  await screen.findByText(/Management not authorized/);
  fireEvent.click(screen.getByRole('button', { name: 'Review management scope' }));
  const confirmation = await screen.findByLabelText(
    /I checked GitLab and confirmed no hook exists/,
  );
  expect((confirmation as HTMLInputElement).checked).toBe(false);
  fireEvent.click(confirmation);
  fireEvent.change(screen.getByLabelText('Management access token'), {
    target: { value: 'write-token' },
  });
  fireEvent.click(screen.getByLabelText(/I authorize ongoing creation/));
  fireEvent.click(screen.getByRole('button', { name: 'Authorize automatic hooks' }));
  await waitFor(() =>
    expect(calls.authorize).toHaveBeenCalledWith(
      'one',
      expect.objectContaining({
        recoveries: [
          { recordId: 'record', attemptedAt: recovery.attemptedAt, confirmedAbsent: true },
        ],
      }),
    ),
  );
});
