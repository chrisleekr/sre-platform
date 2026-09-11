import { beforeEach, expect, test, vi } from 'vitest';
import type { Job } from '@sre/queue';
import type { WorkerDisposition } from '../disposition';
import type { WorkerRuntime } from '../runtime';

const dbMocks = vi.hoisted(() => ({
  getIncident: vi.fn(),
  listIncidentRelations: vi.fn(),
  listIncidentSignals: vi.fn(),
  loadIncidentEvidence: vi.fn(),
  setInvestigationStatus: vi.fn(),
  humanMessagesSince: vi.fn(async () => []),
}));

vi.mock('@sre/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sre/db')>()),
  ...dbMocks,
}));

import { RelationReassessmentHandler } from '../relation-reassessment';

const job: Job = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  type: 'relation.reassess',
  payload: { incidentId: '33333333-3333-4333-8333-333333333333' },
  attempts: 1,
};

beforeEach(() => vi.clearAllMocks());

test('runs a bounded evidence investigation after cohort analysis without merging incidents', async () => {
  const currentId = (job.payload as { incidentId: string }).incidentId;
  const candidateId = '44444444-4444-4444-8444-444444444444';
  const incident = {
    id: currentId,
    tenantId: job.tenantId,
    status: 'open',
    service: 'checkout',
    severity: 'sev2',
    fingerprint: 'checkout-errors',
    alertSource: 'slack',
    investigationStatus: 'assessed',
    trustedAssessmentRunId: 'prior-run',
    rcaSummary: 'Checkout errors are elevated.',
  };
  dbMocks.getIncident.mockResolvedValue(incident);
  dbMocks.listIncidentRelations.mockResolvedValue([
    {
      id: 'relation-1',
      sourceIncidentId: currentId,
      targetIncidentId: candidateId,
      type: 'possible_related',
      rationale: 'Both alerts started in the fixed cohort window.',
      evidence: ['cohort:one'],
      sourceIncident: {
        ...incident,
        title: 'Checkout errors',
        confidence: 80,
      },
      targetIncident: {
        id: candidateId,
        title: 'Database saturation',
        service: 'database',
        severity: 'sev2',
        status: 'open',
        investigationStatus: 'assessed',
        rcaSummary: 'Database writes are saturated.',
        confidence: 90,
      },
    },
  ]);
  dbMocks.listIncidentSignals.mockResolvedValue([
    {
      id: 'signal-1',
      state: 'firing',
      summary: 'Checkout 5xx is elevated.',
      version: 2,
      materialHash: 'material-2',
    },
  ]);
  dbMocks.loadIncidentEvidence.mockResolvedValue([]);

  let investigateInput: { mode?: string; context?: string } | undefined;
  const investigate = vi.fn(async (input: { mode?: string; context?: string }) => {
    investigateInput = input;
    return { outcome: 'inconclusive' };
  });
  const runtime = {
    deps: {
      appDb: {},
      hub: { appendedByOrigin: vi.fn(), publishAppended: vi.fn() },
    },
    withEngineLock: vi.fn(async (_incidentId, run) => run()),
    tools: vi.fn(async () => ({ ctx: {}, tools: [], evidenceReceipts: [] })),
    incidentInput: vi.fn(() => ({ id: currentId })),
    executeEngine: vi.fn(async (_job, _incidentId, operation, _signal, run) => {
      expect(operation).toBe('reassess');
      return run({ investigate });
    }),
  } as unknown as WorkerRuntime;
  const disposition = {
    admitRun: vi.fn(async () => ({ admitted: true, id: 'run-1' })),
    runEngine: vi.fn(async (_tenantId, _incident, _tools, run, options) => {
      expect(options).toMatchObject({
        operation: 'reassess',
        runId: 'run-1',
        assessmentSignalScope: 'complete',
      });
      await run();
      return true;
    }),
    failRun: vi.fn(),
  } as unknown as WorkerDisposition;

  await new RelationReassessmentHandler(runtime, disposition).handle(job, {
    signal: new AbortController().signal,
  });

  expect(investigate).toHaveBeenCalledTimes(1);
  expect(investigateInput).toMatchObject({ mode: 'focused' });
  expect(investigateInput?.context).toContain('causal_candidate_ref=1');
  expect(investigateInput?.context).toContain('Do not merge records.');
  expect(dbMocks.setInvestigationStatus).toHaveBeenCalledWith(
    {},
    job.tenantId,
    currentId,
    'gathering',
  );
});
