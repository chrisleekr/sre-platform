// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const getCredentials = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'bearer' as const, token: 'token' })),
);
vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials }),
}));

import { SmtpSettingsCard } from '../SmtpSettingsCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getCredentials.mockReset().mockResolvedValue({ kind: 'bearer', token: 'token' });
});

describe('SmtpSettingsCard', () => {
  test.each(['credential', 'network', 'malformed'] as const)(
    'hides unclassified %s failure details',
    async (failure) => {
      const diagnostic = 'private-diagnostic-token-value';
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).endsWith('/test')) {
            if (failure === 'network') throw new Error(diagnostic);
            return new Response(diagnostic, { status: 200 });
          }
          return Response.json({
            config: {
              host: 'smtp.example.test',
              port: 587,
              secure: false,
              from: 'alerts@example.test',
            },
            source: 'stored',
            passwordConfigured: false,
          });
        }),
      );
      render(<SmtpSettingsCard />);
      await screen.findByLabelText('SMTP host');
      if (failure === 'credential') getCredentials.mockRejectedValueOnce(new Error(diagnostic));
      fireEvent.click(screen.getByRole('button', { name: 'Send test email' }));
      expect((await screen.findByRole('alert')).textContent).toBe('SMTP test failed.');
      expect(document.body.textContent).not.toContain(diagnostic);
    },
  );
  test('loads secret-free settings, replaces the password, and surfaces a test error', async () => {
    const config = {
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      from: 'alerts@example.test',
      username: 'mailer',
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/test')) {
        return new Response(JSON.stringify({ error: 'relay refused recipient' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (init?.method === 'PUT') {
        return new Response(
          JSON.stringify({
            config,
            source: 'stored',
            passwordConfigured: true,
            updatedAt: '2026-09-05T01:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          config,
          source: 'stored',
          passwordConfigured: true,
          updatedAt: '2026-09-05T01:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    render(<SmtpSettingsCard />);

    expect(((await screen.findByLabelText('SMTP host')) as HTMLInputElement).value).toBe(
      'smtp.example.test',
    );
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: ' new-secret ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    await waitFor(() => expect(screen.getByText('SMTP settings saved.')).toBeDefined());
    const put = fetcher.mock.calls.find((call) => call[1]?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({ password: ' new-secret ', config });
    expect(document.body.textContent).not.toContain('new-secret');

    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'SMTP test failed. Ask an operator to check the mail service.',
    );
    expect(document.body.textContent).not.toContain('relay refused recipient');
  });
});
