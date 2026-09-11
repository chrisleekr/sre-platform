// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CONNECTOR_CATALOG } from '../../connectorPresentation';
import { ConnectorSetupGuide } from '../ConnectorSetupGuide';
import { SetupCommand } from '../../SetupCommand';
import { publicApiOrigin, publicWebhookUrl } from '../event-delivery';
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

test.each([...CONNECTOR_CATALOG.map((item) => item.type), 'slack' as const])(
  '%s has actionable setup and verification instructions',
  (provider) => {
    render(<ConnectorSetupGuide provider={provider} />);
    expect(screen.getByRole('heading', { name: 'Before you start' })).toBeDefined();
    const summary = screen.getByText('Step-by-step setup instructions');
    fireEvent.click(summary);
    expect(summary.closest('details')?.open).toBe(true);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('heading', { name: 'How to confirm it works' })).toBeDefined();
    expect(screen.getByRole('link').getAttribute('href')).toMatch(/^https:\/\//);
  },
);

test('uses the configured HTTPS API origin, not an assumed dashboard host', () => {
  expect(publicApiOrigin('https://api.example.com/')).toBe('https://api.example.com');
  expect(publicWebhookUrl('https://api.example.com', '/webhooks/github/opaque')).toBe(
    'https://api.example.com/webhooks/github/opaque',
  );
  expect(publicWebhookUrl('https://api.example.com', '')).toBe('');
});

test.each([
  'http://localhost:43000',
  'https://api.example.com/prefix',
  'https://user:pass@api.example.com',
  'https://api.example.com?token=secret',
  'https://api.example.com#section',
  '/api',
  'not a url',
])('does not turn an unsuitable origin into a copyable URL: %s', (origin) => {
  expect(publicApiOrigin(origin)).toBe('');
  expect(publicWebhookUrl(origin, '/webhooks/github/opaque')).toBe('');
});

test('does not copy a missing path or external address as a webhook', () => {
  expect(
    publicWebhookUrl('https://api.example.com', '//other.example.com/webhooks/github/key'),
  ).toBe('');
  expect(
    publicWebhookUrl('https://api.example.com', 'https://other.example.com/webhooks/github/key'),
  ).toBe('');
});

test('reports successful copying', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(
    <SetupCommand
      command="https://api.example.com/webhooks/github/opaque"
      copyLabel="Copy webhook URL"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy webhook URL' }));
  expect(await screen.findByText('Copied to clipboard.')).toBeDefined();
  expect(writeText).toHaveBeenCalledWith('https://api.example.com/webhooks/github/opaque');
});

test('provides a manual alternative when copying is denied', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => ({ writeText }) });
  render(<SetupCommand command="kubectl config current-context" />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
  expect(
    await screen.findByText('Clipboard unavailable. Select and copy the text above.'),
  ).toBeDefined();
  expect(screen.getByText('kubectl config current-context')).toBeDefined();
});
