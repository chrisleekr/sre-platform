// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { SignalsPanel } from '../SignalsPanel';

const getCredentials = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'bearer' as const, token: 'jwt' })),
);
vi.mock('../../auth', () => ({ useSession: () => ({ getCredentials }) }));
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'http://api.test' } }));
vi.mock('../../lib/authenticatedFetch', () => ({ authenticatedFetch: vi.fn() }));

const fetchMock = vi.mocked(authenticatedFetch);
const policy = {
  classificationMode: 'enforce',
  retentionDays: 30,
  unsolvedAfterMinutes: 60,
  secondTeamEnabled: true,
  customerVisibleEnabled: true,
  enforcementApprovedAt: '2026-09-02T00:00:00.000Z',
  approvedEvaluationId: 'evaluation-1',
  approvedCorpusVersion: 'corpus',
  approvedContractVersion: 'contract',
  approvedRuntimeFingerprint: 'runtime',
};

const signal = (id: string, summary: string) => ({
  id,
  summary,
  disposition: 'ticket',
  classificationMode: 'enforce',
  effectiveDisposition: 'ticket',
  reason: 'A deferred reliability risk.',
  action: 'Review it.',
  safeDeferralReason: 'No current impact.',
  riskIfIgnored: 'Impact may follow.',
  reviewHorizonMinutes: 60,
  reviewStartedAt: null as string | null,
  incidentId: null,
  actionableTicket: true,
  createdAt: '2026-09-02T00:00:00.000Z',
});

const body = (signals: ReturnType<typeof signal>[], nextCursor: string | null) => ({
  signals,
  nextCursor,
  promotion: {
    ticketCount: 2,
    promotedCount: 0,
    promotionRate: 0,
    averagePromotionAgeSeconds: null,
  },
  policy,
  evaluation: null,
  effectiveClassificationMode: 'enforce',
  enforcementEligibility: { eligible: false, reason: 'Run a current evaluation.' },
  tagLinkRules: [],
});

describe('SignalsPanel', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) =>
      Response.json(
        String(url).includes('cursor=NEXT')
          ? body([signal('older', 'Older unresolved ticket')], null)
          : body([signal('newer', 'Newest unresolved ticket')], 'NEXT'),
      ),
    );
  });

  test('defaults to the ticket queue and appends older tickets with Load more', async () => {
    render(
      <MemoryRouter>
        <SignalsPanel />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Newest unresolved ticket')).toBeDefined();
    const heading = screen.getByRole('heading', { name: 'Newest unresolved ticket' });
    expect(heading.className).toContain('line-clamp-3');
    expect(heading.getAttribute('title')).toBe('Newest unresolved ticket');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('disposition=ticket');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Older unresolved ticket')).toBeDefined();
    expect(screen.getByText('Newest unresolved ticket')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  test('refreshes the first page after starting review', async () => {
    let reviewed = false;
    fetchMock.mockImplementation(async (url, _getToken, init) => {
      if (init?.method === 'POST' && String(url).endsWith('/review')) {
        reviewed = true;
        return Response.json({ signal: { id: 'newer' } });
      }
      return Response.json(
        body(
          [
            {
              ...signal('newer', 'Newest unresolved ticket'),
              reviewStartedAt: reviewed ? '2026-09-02T01:00:00.000Z' : null,
            },
          ],
          null,
        ),
      );
    });
    render(
      <MemoryRouter>
        <SignalsPanel />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Start review' }));
    expect(await screen.findByText('Newest unresolved ticket')).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull());
  });

  test('shows a retryable error when review cannot start', async () => {
    fetchMock.mockImplementation(async (url, _getToken, init) =>
      init?.method === 'POST' && String(url).endsWith('/review')
        ? Response.json({ error: 'Review storage unavailable.' }, { status: 503 })
        : Response.json(body([signal('newer', 'Newest unresolved ticket')], null)),
    );
    render(
      <MemoryRouter>
        <SignalsPanel />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Start review' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Signal action failed. Refresh and retry.',
    );
    expect(
      (screen.getByRole('button', { name: 'Start review' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test('labels shadow proposals separately from their effective route and no-data metrics', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        ...body(
          [
            {
              ...signal('shadow', 'Shadow ticket proposal'),
              classificationMode: 'shadow',
              effectiveDisposition: 'investigate',
              actionableTicket: false,
            },
          ],
          null,
        ),
        promotion: {
          ticketCount: 0,
          promotedCount: 0,
          promotionRate: null,
          averagePromotionAgeSeconds: null,
        },
      }),
    );
    render(
      <MemoryRouter>
        <SignalsPanel />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/shadow proposal: ticket/i)).toBeDefined();
    expect(screen.getByText(/effective route: investigate/i)).toBeDefined();
    const promotion = screen.getByText('Ticket promotion').parentElement;
    expect(promotion).not.toBeNull();
    expect(within(promotion!).getByText('N/A')).toBeDefined();
    expect(within(promotion!).getByText(/0 of 0 promoted/i)).toBeDefined();
    expect(screen.getByRole('tablist', { name: 'Signal disposition' }).getAttribute('style')).toBe(
      'grid-template-columns: repeat(3, minmax(0, 1fr));',
    );
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull();
  });

  test('shows an explicit queue state when a disposition has no records', async () => {
    fetchMock.mockImplementation(async () => Response.json(body([], null)));
    render(
      <MemoryRouter>
        <SignalsPanel />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No tickets need review.')).toBeDefined();
    expect(screen.getByRole('tabpanel', { name: 'Tickets' })).toBeDefined();
  });

  test('keeps keyboard focus in the tablist while loading another disposition', async () => {
    render(
      <MemoryRouter>
        <SignalsPanel />
      </MemoryRouter>,
    );
    await screen.findByText('Newest unresolved ticket');

    const tickets = screen.getByRole('tab', { name: 'Tickets' });
    const investigations = screen.getByRole('tab', { name: 'Investigations' });
    tickets.focus();
    fireEvent.keyDown(tickets, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(investigations);
    expect(tickets.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(investigations, { key: 'Enter' });
    expect(investigations.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(investigations);
    await waitFor(() =>
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('disposition=investigate'),
    );
    expect(document.activeElement).toBe(investigations);
  });
});
