import { beforeEach, expect, test, vi } from 'vitest';
import type { Job } from '@sre/queue';
import type { StructuredGenerator } from '../../engine/types';
import type { WorkerRuntime } from '../runtime';
import type { LlmRuntimeManager } from '../../llm-runtime';

const dbMocks = vi.hoisted(() => ({
  admitInvestigationRun: vi.fn(),
  claimAlertCohortAnalysis: vi.fn(),
  completeInvestigationRun: vi.fn(),
  completeInvestigationRunTx: vi.fn(),
  getIncident: vi.fn(),
  incidentInvestigationMonitorKeys: vi.fn(),
  listIncidentSignals: vi.fn(),
  recordAgentCohortRelationTx: vi.fn(),
  settleAlertCohortTx: vi.fn(),
  withTenant: vi.fn(async (_db, _tenantId, run) => run({ tx: true })),
}));

vi.mock('@sre/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sre/db')>()),
  ...dbMocks,
}));

import { CohortAnalysisHandler } from '../cohort-analysis';

const job: Job = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  type: 'cohort.analyze',
  payload: { cohortId: '33333333-3333-4333-8333-333333333333' },
  attempts: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getIncident.mockResolvedValue({
    id: 'incident-1',
    alertSource: 'alertmanager',
    service: 'service-1',
  });
  dbMocks.listIncidentSignals.mockResolvedValue([]);
  dbMocks.incidentInvestigationMonitorKeys.mockReturnValue(['monitor-1']);
  dbMocks.admitInvestigationRun.mockResolvedValue({ id: 'run-1', admitted: true });
  dbMocks.completeInvestigationRunTx.mockResolvedValue({ id: 'run-1' });
  dbMocks.recordAgentCohortRelationTx.mockResolvedValue({ type: 'possible_related' });
});

function analysis(incidentCount: number, state: 'collecting' | 'settled' = 'collecting') {
  return {
    cohort: {
      state,
      windowStartedAt: new Date('2026-09-01T00:00:00.000Z'),
      windowEndsAt: new Date('2026-09-01T00:02:00.000Z'),
    },
    incidents: Array.from({ length: incidentCount }, (_, index) => ({
      ref: index + 1,
      id: `incident-${index + 1}`,
      title: `Incident ${index + 1}`,
      service: `service-${index + 1}`,
      severity: 'sev2',
      status: 'open',
      signals: [{ summary: `Signal ${index + 1}` }],
    })),
  };
}

test('runs one bounded model decision and persists no ownership changes', async () => {
  dbMocks.claimAlertCohortAnalysis.mockResolvedValue(analysis(3));
  const generator: StructuredGenerator = {
    generate: vi.fn(async () => ({
      decisions: [
        {
          sourceRef: 2,
          targetRef: 1,
          decision: 'possible_related' as const,
          rationale: 'Both symptoms align with one dependency window.',
          confidence: 78,
        },
      ],
    })) as StructuredGenerator['generate'],
  };
  const queue = {
    insertRelationReassessmentTx: vi.fn(async () => ({ jobId: 'relation-job' })),
    publishJob: vi.fn(),
  };
  const runtime = {
    withEngineLock: vi.fn(async (_incidentId: string, run: () => Promise<void>) => run()),
    deps: {
      appDb: {},
      generator,
      queue,
      getAutomaticInvestigationBudget: vi.fn(async () => ({
        tenantRunLimit: 0,
        monitorRunLimit: 0,
        tenantConfiguredCostLimitUsd: 0,
        monitorConfiguredCostLimitUsd: 0,
        configuredCostReady: false,
      })),
    },
  } as unknown as WorkerRuntime;

  await new CohortAnalysisHandler(runtime).handle(job);

  expect(generator.generate).toHaveBeenCalledTimes(1);
  expect(runtime.withEngineLock).toHaveBeenCalledWith('incident-1', expect.any(Function));
  expect(dbMocks.recordAgentCohortRelationTx).toHaveBeenCalledWith(
    { tx: true },
    job.tenantId,
    expect.objectContaining({
      sourceIncidentId: 'incident-2',
      targetIncidentId: 'incident-1',
      type: 'possible_related',
    }),
  );
  expect(dbMocks.admitInvestigationRun).toHaveBeenCalledWith(
    {},
    job.tenantId,
    'incident-1',
    expect.objectContaining({ jobId: job.id, operation: 'reassess' }),
  );
  expect(dbMocks.completeInvestigationRunTx).toHaveBeenCalledTimes(1);
  expect(dbMocks.settleAlertCohortTx).toHaveBeenCalledWith(
    { tx: true },
    '33333333-3333-4333-8333-333333333333',
  );
  expect(queue.insertRelationReassessmentTx).toHaveBeenCalledWith(
    { tx: true },
    job.tenantId,
    'incident-2',
  );
  expect(queue.publishJob).toHaveBeenCalledWith('relation-job');
});

test('passes the attempt signal to the runtime and rethrows an aborted provider call', async () => {
  dbMocks.claimAlertCohortAnalysis.mockResolvedValue(analysis(3));
  const controller = new AbortController();
  const reason = new Error('deadline');
  const execute = vi.fn(async (meta, run) => {
    expect(meta.signal).toBe(controller.signal);
    controller.abort(reason);
    return run({
      generator: {
        generate: vi.fn(async () => {
          throw reason;
        }),
      },
    } as never);
  });
  const runtime = {
    withEngineLock: vi.fn(async (_incidentId: string, run: () => Promise<void>) => run()),
    deps: {
      appDb: {},
      llm: { execute } as unknown as LlmRuntimeManager,
      queue: {},
      getAutomaticInvestigationBudget: vi.fn(async () => ({
        tenantRunLimit: 0,
        monitorRunLimit: 0,
        tenantConfiguredCostLimitUsd: 0,
        monitorConfiguredCostLimitUsd: 0,
        configuredCostReady: false,
      })),
    },
  } as unknown as WorkerRuntime;

  await expect(new CohortAnalysisHandler(runtime).handle(job, controller.signal)).rejects.toBe(
    reason,
  );
  expect(dbMocks.completeInvestigationRun).not.toHaveBeenCalled();
  expect(dbMocks.completeInvestigationRunTx).not.toHaveBeenCalled();
});

test('settles a single-incident cohort without spending a model call', async () => {
  dbMocks.claimAlertCohortAnalysis.mockResolvedValue(analysis(1));
  const generator = { generate: vi.fn() } as unknown as StructuredGenerator;
  const runtime = { deps: { appDb: {}, generator, queue: {} } } as unknown as WorkerRuntime;

  await new CohortAnalysisHandler(runtime).handle(job);

  expect(generator.generate).not.toHaveBeenCalled();
  expect(dbMocks.recordAgentCohortRelationTx).not.toHaveBeenCalled();
  expect(dbMocks.admitInvestigationRun).not.toHaveBeenCalled();
  expect(dbMocks.settleAlertCohortTx).toHaveBeenCalledTimes(1);
});

test('does not spend another model call when a settled cohort job is retried', async () => {
  dbMocks.claimAlertCohortAnalysis.mockResolvedValue(null);
  const generator = { generate: vi.fn() } as unknown as StructuredGenerator;
  const queue = {
    insertRelationReassessmentTx: vi.fn(),
    publishJob: vi.fn(),
  };
  const runtime = { deps: { appDb: {}, generator, queue } } as unknown as WorkerRuntime;

  await new CohortAnalysisHandler(runtime).handle(job);

  expect(generator.generate).not.toHaveBeenCalled();
  expect(dbMocks.recordAgentCohortRelationTx).not.toHaveBeenCalled();
  expect(dbMocks.admitInvestigationRun).not.toHaveBeenCalled();
  expect(dbMocks.settleAlertCohortTx).not.toHaveBeenCalled();
  expect(queue.insertRelationReassessmentTx).not.toHaveBeenCalled();
});
