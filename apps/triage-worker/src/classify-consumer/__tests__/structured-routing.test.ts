import { beforeEach, expect, test, vi } from 'vitest';
import type { InboundCandidate } from '@sre/connectors';
import type { Job } from '@sre/queue';
import type { ClassifyAttachments } from '../attachments';
import type { ClassifyCore } from '../core';

const dbMocks = vi.hoisted(() => ({
  getPreviousSlackMonitorEpisodeTx: vi.fn(),
  joinAlertCohortTx: vi.fn(),
  listSignalsByExternalRoot: vi.fn(),
  recordIncidentRelationTx: vi.fn(),
}));

vi.mock('@sre/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sre/db')>()),
  ...dbMocks,
}));

import { StructuredFiringRouter } from '../structured-routing';

const candidate: InboundCandidate = {
  externalId: '1788000000.000001',
  channel: 'C-ALERTS',
  author: 'bot',
  producerId: 'B-ALERTMANAGER',
  text: 'Checkout errors high',
  raw: { alert: 'CheckoutErrorsHigh' },
  signalState: 'firing',
  alertKind: 'firing',
  eventKey: 'slack:event:1:producer:B-ALERTMANAGER',
  eventAt: '2026-09-01T00:00:00.000Z',
  contentHash: 'content',
  isEdit: false,
  observations: [
    {
      externalMessageId: '1788000000.000001#checkout',
      state: 'firing',
      summary: 'Checkout errors high',
      contentHash: 'content',
      eventKey: 'slack:event:1:observation:checkout:producer:B-ALERTMANAGER',
      eventAt: '2026-09-01T00:00:00.000Z',
      monitorKey: 'slack:checkout-errors',
      alertName: 'CheckoutErrorsHigh',
      materialHash: 'material',
    },
  ],
};

const job: Job = {
  id: 'job-1',
  tenantId: 'tenant-1',
  type: 'classify',
  payload: candidate,
  attempts: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getPreviousSlackMonitorEpisodeTx.mockResolvedValue(null);
  dbMocks.joinAlertCohortTx.mockResolvedValue({
    id: 'cohort-1',
    windowEndsAt: new Date('2026-09-01T00:02:00.000Z'),
  });
  dbMocks.listSignalsByExternalRoot.mockResolvedValue([
    {
      id: 'signal-1',
      incidentId: 'incident-new',
      monitorKey: 'slack:checkout-errors',
      firstSeenAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  ]);
});

function setup() {
  const emitOutcome = vi.fn();
  const openNewIncident = vi.fn(async (...args: unknown[]) => {
    const options = args[8] as {
      onRoutedTx?: (
        tx: object,
        routed: { incidentId: string; bindingId: string; reused: boolean; signalId: string },
      ) => Promise<string[]>;
    };
    await options.onRoutedTx?.(
      {},
      { incidentId: 'incident-new', bindingId: 'binding-new', reused: false, signalId: 'signal-1' },
    );
  });
  const core = {
    deps: {
      appDb: {},
      queue: {
        insertCohortAnalysisTx: vi.fn(async () => ({ jobId: 'cohort-job' })),
      },
    },
    emitOutcome,
    openNewIncident,
    openerFor: vi.fn(() => ({
      author: 'system',
      content: candidate.text,
      originSurface: 'slack',
      originMessageId: 'slack:C-ALERTS:1788000000.000001',
    })),
    signalsFor: vi.fn(() => [
      {
        ...candidate.observations![0]!,
        surface: 'slack',
        channel: candidate.channel,
        eventAt: new Date(candidate.eventAt),
      },
    ]),
    withRoutingFence: vi.fn(async (_tenantId, _candidate, run) => ({
      status: 'executed' as const,
      value: await run(),
    })),
  } as unknown as ClassifyCore;
  const attachments = {
    attachBot: vi.fn(),
    foldIntoOwner: vi.fn(() => vi.fn()),
  } as unknown as ClassifyAttachments;
  return { attachments, core, emitOutcome, openNewIncident };
}

test('opens a new episode without invoking general incident classification', async () => {
  const fixture = setup();

  expect(
    await new StructuredFiringRouter(fixture.core, fixture.attachments).handle(
      candidate,
      candidate,
      job,
      'slack:fingerprint',
      candidate.text,
    ),
  ).toBe(true);

  expect(fixture.openNewIncident).toHaveBeenCalledTimes(1);
  expect(dbMocks.joinAlertCohortTx).toHaveBeenCalledWith(
    {},
    job.tenantId,
    expect.objectContaining({ sourceScopeKey: 'slack:C-ALERTS:producer:B-ALERTMANAGER' }),
  );
  expect(fixture.emitOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'provider_alert_opened' }),
  );
});

test('opens a new source episode even when the monitor previously fired', async () => {
  const fixture = setup();

  expect(
    await new StructuredFiringRouter(fixture.core, fixture.attachments).handle(
      candidate,
      candidate,
      job,
      'slack:fingerprint',
      candidate.text,
    ),
  ).toBe(true);

  expect(fixture.openNewIncident).toHaveBeenCalledTimes(1);
  expect(fixture.attachments.attachBot).not.toHaveBeenCalled();
});
