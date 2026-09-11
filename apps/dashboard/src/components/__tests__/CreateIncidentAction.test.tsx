// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { installDialogMethods } from '../../test/dialog';
import { CreateIncidentAction } from '../CreateIncidentAction';

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'http://api.test' } }));

let dialogMethods: ReturnType<typeof installDialogMethods>;

beforeEach(() => {
  dialogMethods = installDialogMethods();
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000123');
});

afterEach(() => {
  cleanup();
  dialogMethods.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderAction() {
  return render(
    <MemoryRouter initialEntries={['/w/incidents']}>
      <Routes>
        <Route path="/w/incidents" element={<CreateIncidentAction />} />
        <Route path="/w/incidents/:id" element={<h1>Incident workspace</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

function completeForm() {
  fireEvent.change(screen.getByLabelText('Incident title'), {
    target: { value: 'Checkout latency increased' },
  });
  fireEvent.change(screen.getByLabelText('Service or system'), {
    target: { value: 'checkout-api' },
  });
  fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'sev2' } });
  fireEvent.change(screen.getByLabelText('What should SRE Platform investigate?'), {
    target: { value: 'Latency rose immediately after the latest deployment.' },
  });
}

describe('CreateIncidentAction', () => {
  test('creates a human-reported investigation and opens its workspace', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { outcome: 'created', incidentId: '00000000-0000-4000-8000-000000000456' },
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderAction();

    fireEvent.click(screen.getByRole('button', { name: 'Create incident' }));
    expect(screen.getByRole('dialog', { name: 'Create incident' })).toBeDefined();
    expect(screen.getByText(/token usage and cost are recorded/i)).toBeDefined();
    completeForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create and investigate' }));

    await screen.findByRole('heading', { name: 'Incident workspace' });
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/incidents', {
      method: 'POST',
      headers: {
        authorization: 'Bearer jwt',
        'content-type': 'application/json',
        'x-sre-session': '1',
      },
      credentials: 'include',
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000123',
        title: 'Checkout latency increased',
        description: 'Latency rose immediately after the latest deployment.',
        service: 'checkout-api',
        severity: 'sev2',
      }),
    });
  });

  test('keeps the report and idempotency key when creation fails so retry is safe', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: 'incident declaration unavailable' }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { outcome: 'created', incidentId: '00000000-0000-4000-8000-000000000456' },
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    renderAction();

    fireEvent.click(screen.getByRole('button', { name: 'Create incident' }));
    completeForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create and investigate' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not create the incident. Refresh and retry.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create and investigate' }));
    await screen.findByRole('heading', { name: 'Incident workspace' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).requestId).toBe(
      JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).requestId,
    );
    await waitFor(() => expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1));
  });
});
