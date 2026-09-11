// @vitest-environment jsdom
import type { PostmortemDetail } from '@sre/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'http://api.test' } }));

import { PostmortemPage } from '../PostmortemPage';

const INCIDENT_ID = '11111111-1111-4111-8111-111111111111';
const POSTMORTEM_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';

function detail(over: Partial<PostmortemDetail['postmortem']> = {}): PostmortemDetail {
  return {
    postmortem: {
      id: POSTMORTEM_ID,
      incidentId: INCIDENT_ID,
      status: 'draft',
      trigger: 'data_loss',
      revision: 1,
      assessmentRunId: null,
      requestedByUserId: null,
      publishedByUserId: null,
      publishedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      summary: 'Checkout returned 500s for 20 minutes.',
      impact: 'Orders failed.',
      contributingCauses: [{ cause: 'Connection pool exhausted after a deploy.', evidenceIds: [] }],
      triggerNarrative: 'A deploy doubled query volume.',
      resolution: 'Rolled back.',
      detection: 'Synthetic checks paged.',
      lessons: { wentWell: ['Rollback was fast.'], wentWrong: ['No pool alert.'], lucky: [] },
      timeline: [{ at: '2026-08-31T10:00:00Z', event: 'Deploy started.' }],
      supportingInformation: null,
      ...over,
    },
    actionItems: [
      {
        id: ITEM_ID,
        postmortemId: POSTMORTEM_ID,
        type: 'prevent',
        title: 'Alert on pool saturation',
        owner: null,
        trackerUrl: null,
        state: 'open',
        dueAt: null,
        completedAt: null,
        generated: true,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    grade: null,
  };
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function renderPage(pollMs = 20) {
  return render(
    <MemoryRouter initialEntries={[`/w/incidents/${INCIDENT_ID}/postmortem`]}>
      <Routes>
        <Route path="/w/incidents/:id/postmortem" element={<PostmortemPage pollMs={pollMs} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const originalFetch = globalThis.fetch;
const originalConfirm = window.confirm;
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.confirm = originalConfirm;
});

describe('PostmortemPage', () => {
  test('polls through the 404 while generation runs, then renders the document', async () => {
    let reads = 0;
    const fetchMock = vi.fn<FetchImpl>(async () => {
      reads += 1;
      return reads < 3 ? response({ error: 'postmortem not found' }, 404) : response(detail());
    });
    globalThis.fetch = fetchMock;
    const view = renderPage();
    expect(await screen.findByText('Generating postmortem…')).toBeDefined();
    expect(((await screen.findByLabelText('Summary')) as HTMLTextAreaElement).value).toBe(
      'Checkout returned 500s for 20 minutes.',
    );
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Draft')).toBeDefined();
    expect(screen.getByText('Trigger: Data loss')).toBeDefined();
    view.unmount();
  });

  test('stops polling after the wait bound and Retry resumes it', async () => {
    let found = false;
    const fetchMock = vi.fn<FetchImpl>(async () =>
      found ? response(detail()) : response({ error: 'postmortem not found' }, 404),
    );
    globalThis.fetch = fetchMock;
    // The bound is elapsed time in poll periods: 5 ms polls put 100 periods at 500 ms.
    const view = renderPage(5);
    expect(await screen.findByText('Generating postmortem…')).toBeDefined();
    const panel = await screen.findByRole('alert', {}, { timeout: 3_000 });
    expect(panel.textContent).toContain('Postmortem generation did not finish.');
    expect(panel.textContent).toContain('Check the incident timeline for a failure note.');
    expect(screen.queryByText('Generating postmortem…')).toBeNull();
    // Turning polling off issues one final read. A fixed sleep can sample it in flight on a loaded
    // worker, so wait until two consecutive samples agree, then confirm no further reads happen.
    let settled = -1;
    await waitFor(() => {
      const now = fetchMock.mock.calls.length;
      const stable = now === settled;
      settled = now;
      expect(stable).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBe(settled);
    // Retry while the API still 404s: the panel must clear and polling must resume, not just the
    // single read a nonce bump would issue on its own.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(settled + 1));
    found = true;
    expect(await screen.findByLabelText('Summary')).toBeDefined();
    view.unmount();
  });

  test('Regenerate posts the stored trigger and adopts only a new revision', async () => {
    let revision = 1;
    let clicked = false;
    // Post-click revision-1 reads carry a changed action item. Action items are props, not editor
    // state, so adopting a stale read would render the new title.
    const staleRead = (): PostmortemDetail => {
      const base = detail();
      return { ...base, actionItems: [{ ...base.actionItems[0]!, title: 'Stale poll item' }] };
    };
    const fetchMock = vi.fn<FetchImpl>(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/generate')) {
        clicked = true;
        return response({ jobId: 'job-1' }, 202);
      }
      if (revision === 2) return response(detail({ revision: 2, summary: 'New draft.' }));
      return response(clicked ? staleRead() : detail());
    });
    globalThis.fetch = fetchMock;
    const reads = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST').length;
    const view = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/incidents/${INCIDENT_ID}/postmortem/generate`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ trigger: detail().postmortem.trigger }),
        }),
      ),
    );
    expect((await screen.findByRole('status')).textContent).toContain('Regenerating draft…');
    expect((screen.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Polls that still return revision 1 are ignored: the status stays and nothing is adopted.
    const before = reads();
    await waitFor(() => expect(reads()).toBeGreaterThan(before + 1));
    expect(screen.getByRole('status').textContent).toContain('Regenerating draft…');
    expect(screen.getByText('Revision 1')).toBeDefined();
    expect(screen.queryByLabelText('State for Stale poll item')).toBeNull();
    expect(screen.getByLabelText('State for Alert on pool saturation')).toBeDefined();
    revision = 2;
    expect(await screen.findByText('Revision 2')).toBeDefined();
    expect((screen.getByLabelText('Summary') as HTMLTextAreaElement).value).toBe('New draft.');
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    view.unmount();
  });

  test('Save sends the sections with the revision it read', async () => {
    const fetchMock = vi.fn<FetchImpl>(async (_input, init) =>
      init?.method === 'PATCH'
        ? response(detail({ revision: 2, summary: 'Edited summary.' }))
        : response(detail()),
    );
    globalThis.fetch = fetchMock;
    const view = renderPage();
    fireEvent.change(await screen.findByLabelText('Summary'), {
      target: { value: 'Edited summary.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save postmortem' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/incidents/${INCIDENT_ID}/postmortem`,
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    const body = JSON.parse(String(patch[1]?.body)) as { revision: number; summary: string };
    expect(body.revision).toBe(1);
    expect(body.summary).toBe('Edited summary.');
    expect(await screen.findByText('Revision 2')).toBeDefined();
    view.unmount();
  });

  test('a 409 on Save asks for a reload instead of overwriting', async () => {
    const fetchMock = vi.fn<FetchImpl>(async (_input, init) =>
      init?.method === 'PATCH' ? response({ error: 'stale' }, 409) : response(detail()),
    );
    globalThis.fetch = fetchMock;
    const view = renderPage();
    fireEvent.change(await screen.findByLabelText('Summary'), { target: { value: 'Edited.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save postmortem' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Reload');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
    view.unmount();
  });

  test('Publish confirms, posts publish and reloads the published document', async () => {
    window.confirm = vi.fn(() => true);
    let published = false;
    const fetchMock = vi.fn<FetchImpl>(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/publish')) {
        published = true;
        return response({ published: true, gradeJobId: 'job-2' });
      }
      return response(
        published
          ? detail({ status: 'published', publishedAt: '2026-09-02T00:00:00.000Z' })
          : detail(),
      );
    });
    globalThis.fetch = fetchMock;
    const view = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/incidents/${INCIDENT_ID}/postmortem/publish`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const publishedButton = (await screen.findByRole('button', {
      name: 'Published',
    })) as HTMLButtonElement;
    expect(publishedButton.disabled).toBe(true);
    expect(screen.getByText('Was the root-cause assessment right?')).toBeDefined();
    view.unmount();
  });

  test('a declined confirm never posts publish', async () => {
    window.confirm = vi.fn(() => false);
    const fetchMock = vi.fn<FetchImpl>(async () => response(detail()));
    globalThis.fetch = fetchMock;
    const view = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    view.unmount();
  });

  test('flags an action item without an owner or tracker link as untracked', async () => {
    globalThis.fetch = vi.fn<FetchImpl>(async () => response(detail()));
    const view = renderPage();
    expect(await screen.findByText('Untracked')).toBeDefined();
    view.unmount();
  });

  test('changing an action item state patches that item', async () => {
    const fetchMock = vi.fn<FetchImpl>(async (_input, init) => {
      if (init?.method === 'PATCH') {
        const item = detail().actionItems[0]!;
        return response({ actionItem: { ...item, state: 'in_progress', updatedAt: 'later' } });
      }
      return response(detail());
    });
    globalThis.fetch = fetchMock;
    const view = renderPage();
    fireEvent.change(await screen.findByLabelText('State for Alert on pool saturation'), {
      target: { value: 'in_progress' },
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/incidents/${INCIDENT_ID}/postmortem/action-items/${ITEM_ID}`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ state: 'in_progress' }),
        }),
      ),
    );
    view.unmount();
  });

  test('grade buttons post the responder verdict with its rationale', async () => {
    const fetchMock = vi.fn<FetchImpl>(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/grade')) {
        return response(
          {
            grade: {
              id: 'g1',
              incidentId: INCIDENT_ID,
              runId: 'run-1',
              claimedConfidence: 80,
              runbookCited: false,
              modelVerdict: 'correct',
              modelRationale: 'The pool exhaustion matches.',
              groundTruthSource: 'postmortem',
              humanVerdict: 'partial',
              humanRationale: 'Missed the deploy.',
              gradedByUserId: 'u1',
              effectiveVerdict: 'partial',
              createdAt: 'x',
              updatedAt: 'y',
            },
          },
          201,
        );
      }
      return response(detail({ status: 'published', publishedAt: '2026-09-02T00:00:00.000Z' }));
    });
    globalThis.fetch = fetchMock;
    const view = renderPage();
    fireEvent.change(await screen.findByLabelText('Rationale'), {
      target: { value: 'Missed the deploy.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Partially right' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/incidents/${INCIDENT_ID}/postmortem/grade`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ verdict: 'partial', rationale: 'Missed the deploy.' }),
        }),
      ),
    );
    const region = screen.getByRole('region', { name: 'Assessment grade' });
    await waitFor(() => expect(region.textContent).toContain('Responder verdict:'));
    expect(region.textContent).toContain('Model judge:');
    expect(region.textContent).toContain('Missed the deploy.');
    view.unmount();
  });
});
