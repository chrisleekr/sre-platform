// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GitLabPollingCoverage } from '../gitlab-connect/PollingCoverage';

test('separates overlapping coverage counts, failures, backlog and delivery proof', () => {
  render(
    <GitLabPollingCoverage
      coverage={{
        total: 12,
        notChecked: 4,
        failed: 2,
        backlog: 3,
        trackingLimited: 1,
        oldestReadAt: null,
        latestReadAt: null,
        projects: [
          {
            project: 'platform/failing-service',
            lastAttemptAt: null,
            lastSuccessAt: null,
            failureCategory: 'permission_denied',
            backlog: true,
            trackingLimited: true,
          },
        ],
      }}
    />,
  );
  expect(
    screen.getByText('12 projects · 4 not yet checked · 2 failing · 3 with backlog'),
  ).toBeDefined();
  expect(screen.getByText(/does not prove webhook delivery/)).toBeDefined();
  expect(screen.getByText(/1 of 12/)).toBeDefined();
  expect(screen.getByText(/Read failed: permission denied/)).toBeDefined();
  expect(screen.getByText(/Check this project's access/)).toBeDefined();
  expect(screen.getByText(/Active-work tracking limit reached in 1 project/)).toBeDefined();
  expect(screen.getByText(/A later successful read does not clear/)).toBeDefined();
});

test('explains incomplete timestamp-boundary coverage without suggesting credential rotation', () => {
  render(
    <GitLabPollingCoverage
      coverage={{
        total: 1,
        notChecked: 1,
        failed: 1,
        backlog: 1,
        trackingLimited: 0,
        oldestReadAt: null,
        latestReadAt: null,
        projects: [
          {
            project: 'platform/busy-service',
            lastAttemptAt: null,
            lastSuccessAt: null,
            failureCategory: 'timestamp_boundary_limit',
            backlog: true,
            trackingLimited: false,
          },
        ],
      }}
    />,
  );
  expect(screen.getByText(/Coverage is incomplete; the cursor is retained/)).toBeDefined();
  expect(screen.getByText(/Use group or project hooks/)).toBeDefined();
  expect(screen.queryByText(/Check this project's access/)).toBeNull();
});
