import { beforeEach, expect, test, vi } from 'vitest';
import type { TriageResult } from '../../engine/types';
import type { WorkerRuntime } from '../runtime';

const dbMocks = vi.hoisted(() => ({
  clearRecoveryTx: vi.fn(),
  getIncidentLifecycleTx: vi.fn(),
  listResponseGroupSignalsTx: vi.fn(),
  lockResponseGroupWorkTx: vi.fn(),
  prepareResponseGroupRecoveryTx: vi.fn(),
  promoteCausalFindingsTx: vi.fn(),
  resolveResponseRootTx: vi.fn(),
  transitionIncidentTx: vi.fn(),
}));

vi.mock('@sre/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sre/db')>()),
  ...dbMocks,
}));

import { promoteCausalityAndRefreshRecovery } from '../causal-recovery';

beforeEach(() => vi.clearAllMocks());

test('rebuilds and enqueues the complete response-group recovery after causal promotion', async () => {
  dbMocks.resolveResponseRootTx.mockResolvedValue('root-incident');
  dbMocks.promoteCausalFindingsTx.mockResolvedValue([
    {
      id: 'causal-relation',
      sourceIncidentId: 'child-incident',
      targetIncidentId: 'root-incident',
    },
  ]);
  dbMocks.lockResponseGroupWorkTx.mockResolvedValue({
    rootIncidentId: 'root-incident',
    incidentIds: ['root-incident', 'child-incident'],
  });
  dbMocks.getIncidentLifecycleTx.mockResolvedValue({ status: 'open', version: 4 });
  dbMocks.prepareResponseGroupRecoveryTx.mockResolvedValue({
    rootIncidentId: 'root-incident',
    lifecycleVersion: 4,
    signalFence: 'root-signal:2:resolved|child-signal:3:resolved',
  });
  const insertRecoveryTx = vi.fn(async () => ({ jobId: 'recovery-job' }));
  const relationshipMessages = [
    { id: 'child-relationship', incidentId: 'child-incident' },
    { id: 'root-relationship', incidentId: 'root-incident' },
  ];
  const appendTxOnce = vi
    .fn()
    .mockResolvedValueOnce({ message: relationshipMessages[0], inserted: true })
    .mockResolvedValueOnce({ message: relationshipMessages[1], inserted: true });
  const runtime = {
    deps: { hub: { appendTxOnce }, queue: { insertRecoveryTx } },
  } as unknown as WorkerRuntime;
  const result = {
    causalFindings: [
      {
        candidateRef: 1,
        direction: 'candidate_caused_this',
        rationale: 'The candidate caused this symptom.',
        confidence: 95,
        evidenceIds: ['evidence-1'],
      },
    ],
  } as TriageResult;

  await expect(
    promoteCausalityAndRefreshRecovery(
      runtime,
      { transaction: true } as never,
      'tenant-1',
      'child-incident',
      'run-1',
      result,
      ['evidence-1'],
      [],
    ),
  ).resolves.toEqual({
    recoveryJobId: 'recovery-job',
    lifecycleMessage: null,
    relationshipMessages,
  });

  expect(dbMocks.prepareResponseGroupRecoveryTx).toHaveBeenCalledWith(
    { transaction: true },
    'tenant-1',
    'child-incident',
  );
  expect(insertRecoveryTx).toHaveBeenCalledWith(
    { transaction: true },
    'tenant-1',
    'root-incident',
    4,
    'root-signal:2:resolved|child-signal:3:resolved',
  );
  expect(dbMocks.clearRecoveryTx).toHaveBeenCalledWith(
    { transaction: true },
    'tenant-1',
    'root-incident',
  );
});

test('does not enqueue recovery when no causal finding was promoted', async () => {
  dbMocks.promoteCausalFindingsTx.mockResolvedValue([]);
  const insertRecoveryTx = vi.fn();
  const runtime = {
    deps: { queue: { insertRecoveryTx } },
  } as unknown as WorkerRuntime;

  await expect(
    promoteCausalityAndRefreshRecovery(
      runtime,
      {} as never,
      'tenant-1',
      'incident-1',
      'run-1',
      {} as TriageResult,
      [],
      [],
    ),
  ).resolves.toEqual({
    recoveryJobId: null,
    lifecycleMessage: null,
    relationshipMessages: [],
  });

  expect(dbMocks.prepareResponseGroupRecoveryTx).not.toHaveBeenCalled();
  expect(insertRecoveryTx).not.toHaveBeenCalled();
});

test('atomically reopens a resolved response root when a newly promoted child is firing', async () => {
  dbMocks.promoteCausalFindingsTx.mockResolvedValue([
    {
      id: 'causal-relation',
      sourceIncidentId: 'child-incident',
      targetIncidentId: 'root-incident',
    },
  ]);
  dbMocks.lockResponseGroupWorkTx.mockResolvedValue({
    rootIncidentId: 'root-incident',
    incidentIds: ['root-incident', 'child-incident'],
  });
  dbMocks.getIncidentLifecycleTx.mockResolvedValue({ status: 'resolved', version: 4 });
  dbMocks.prepareResponseGroupRecoveryTx.mockResolvedValue(null);
  dbMocks.resolveResponseRootTx.mockResolvedValue('root-incident');
  dbMocks.listResponseGroupSignalsTx.mockResolvedValue([{ id: 'signal-1', state: 'firing' }]);
  dbMocks.transitionIncidentTx.mockResolvedValue({
    outcome: 'applied',
    from: 'resolved',
    to: 'open',
    version: 5,
  });
  const lifecycleMessage = { id: 'lifecycle-message', incidentId: 'root-incident' };
  const relationshipMessages = [
    { id: 'child-relationship', incidentId: 'child-incident' },
    { id: 'root-relationship', incidentId: 'root-incident' },
  ];
  const appendTx = vi.fn(async () => lifecycleMessage);
  const appendTxOnce = vi
    .fn()
    .mockResolvedValueOnce({ message: relationshipMessages[0], inserted: true })
    .mockResolvedValueOnce({ message: relationshipMessages[1], inserted: true });
  const runtime = {
    deps: {
      hub: { appendTx, appendTxOnce },
      queue: { insertRecoveryTx: vi.fn() },
    },
  } as unknown as WorkerRuntime;
  const result = {
    causalFindings: [
      {
        candidateRef: 1,
        direction: 'candidate_caused_this',
        rationale: 'The child is a firing symptom of the resolved root.',
        confidence: 95,
        evidenceIds: ['evidence-1'],
      },
    ],
  } as TriageResult;

  await expect(
    promoteCausalityAndRefreshRecovery(
      runtime,
      {} as never,
      'tenant-1',
      'child-incident',
      'run-1',
      result,
      ['evidence-1'],
      [],
    ),
  ).resolves.toEqual({ recoveryJobId: null, lifecycleMessage, relationshipMessages });

  expect(dbMocks.transitionIncidentTx).toHaveBeenCalledWith({}, 'root-incident', 'open');
  expect(appendTx).toHaveBeenCalledWith(
    {},
    'tenant-1',
    'root-incident',
    expect.objectContaining({
      kind: 'lifecycle',
      lifecycleFrom: 'resolved',
      lifecycleTo: 'open',
      lifecycleVersion: 5,
    }),
  );
});
