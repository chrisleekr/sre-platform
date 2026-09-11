// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../theme';
import { SignInMethodSetup, type SignInMethodInput } from '../SignInMethodSetup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

test('retries an unchanged work domain after a temporary eligibility failure', async () => {
  let eligibilityCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.endsWith('/eligibility')) return Response.json({});
      eligibilityCalls++;
      return eligibilityCalls === 1
        ? Response.json({ error: 'Try later' }, { status: 503 })
        : Response.json({ eligible: true });
    }),
  );
  const submit = vi.fn(async () => {});
  render(
    <ThemeProvider>
      <MemoryRouter>
        <SignInMethodSetup submitLabel="Connect" onSubmit={submit} />
      </MemoryRouter>
    </ThemeProvider>,
  );
  fireEvent.change(screen.getByLabelText(/Directory URL|Auth0 domain /i), {
    target: { value: 'https://directory.example.test' },
  });
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client' } });
  fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret' } });
  fireEvent.change(screen.getByLabelText('Work email domain'), {
    target: { value: 'company.example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByText('Try later');
  expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(eligibilityCalls).toBe(2);
});

test.each([
  ['auth0', 'client_secret_post'],
  ['okta', 'client_secret_basic'],
  ['entra', 'client_secret_post'],
  ['google-workspace', 'client_secret_post'],
  ['other', 'client_secret_post'],
  ['other', 'client_secret_basic'],
  ['other', 'none'],
])('%s submits the matching %s registration without storing its secret', async (preset, method) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ eligible: true })),
  );
  const submit = vi.fn(async (_input: SignInMethodInput) => {});
  render(
    <ThemeProvider>
      <MemoryRouter>
        <SignInMethodSetup submitLabel="Connect" onSubmit={submit} draftKey="client-auth-test" />
      </MemoryRouter>
    </ThemeProvider>,
  );
  fireEvent.change(screen.getByLabelText('Identity service'), { target: { value: preset } });
  if (preset === 'other')
    fireEvent.change(screen.getByLabelText('Application authentication'), {
      target: { value: method },
    });
  fireEvent.change(screen.getByLabelText(/Directory URL|Auth0 domain /i), {
    target: { value: 'https://directory.example.test' },
  });
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'registered-client' } });
  fireEvent.change(screen.getByLabelText('Work email domain'), {
    target: { value: 'team.example.test' },
  });
  if (method !== 'none')
    fireEvent.change(screen.getByLabelText('Client secret'), {
      target: { value: 'write-only-secret' },
    });
  else expect(screen.queryByLabelText('Client secret')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0]?.[0]).toMatchObject({
    clientAuthentication: method,
    ...(method === 'none' ? {} : { clientSecret: 'write-only-secret' }),
  });
  if (method === 'none') expect(submit.mock.calls[0]?.[0]).not.toHaveProperty('clientSecret');
  expect(JSON.stringify({ ...sessionStorage })).not.toContain('write-only-secret');
  expect(JSON.parse(sessionStorage.getItem('client-auth-test')!)).toMatchObject({
    preset,
    clientAuthentication: method,
  });
});
