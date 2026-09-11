// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SystemHookFields, SystemHookTroubleshooting } from '../gitlab-connect/SystemHookFields';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('shows exact instance settings, copyable receiver and name, trigger fields and authentication instructions', async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(
    <SystemHookFields
      baseUrl="https://gitlab.example.com"
      receiver="https://smee.io/test-channel"
      name="SRE Platform abcdef01"
    />,
  );
  expect(
    screen
      .getByRole('link', { name: "Open this GitLab instance's system hooks" })
      .getAttribute('href'),
  ).toBe('https://gitlab.example.com/admin/hooks');
  fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://smee.io/test-channel'));
  fireEvent.click(screen.getByRole('button', { name: 'Copy Name' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('SRE Platform abcdef01'));
  for (const name of [
    'Push events',
    'Tag push events',
    'Merge request events',
    'Repository update events',
    'Enable SSL verification',
  ])
    expect(screen.getByText(name, { exact: true })).toBeDefined();
  expect(screen.getByText('Secret token is not the signing token')).toBeDefined();
  expect(screen.getByText(/there is no project-only scope selector/)).toBeDefined();
  expect(
    screen.getByText(/CI\/CD and release events are supplied by read-only polling/),
  ).toBeDefined();
  expect(screen.getByText(/you do not also need to add a hook manually/)).toBeDefined();
});

test('does not invent an unavailable receiver and explains recoverable delivery failures', () => {
  render(
    <>
      <SystemHookFields baseUrl="https://gitlab.example.com" receiver="" name="" />
      <SystemHookTroubleshooting />
    </>,
  );
  expect((screen.getByRole('button', { name: 'Copy URL' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole('button', { name: 'Copy Name' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.getByText(/An ignored event is not delivery proof/)).toBeDefined();
  expect(screen.getByText(/A signing token pasted into Secret token will not work/)).toBeDefined();
  expect(screen.getByText(/Check Project polling coverage/)).toBeDefined();
});
