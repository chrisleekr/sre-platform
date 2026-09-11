import { entityCandidateKey, type AffectedEntityCandidate } from '@sre/contracts';
import type { IDataSourceConnector } from '@sre/connectors';
import type { Db } from '@sre/db';
import { beforeEach, expect, test, vi } from 'vitest';
import { makeInMemoryAuditSink } from '../audit';
import { runTool } from '../dispatch';
import { makeResolveEntityContextTool } from '../entity-context';

const mocks = vi.hoisted(() => ({ resolveIncidentEntityContext: vi.fn() }));

vi.mock('@sre/db', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveIncidentEntityContext: mocks.resolveIncidentEntityContext,
}));

beforeEach(() => mocks.resolveIncidentEntityContext.mockReset());

test('runs entity resolution through connector coverage and keeps safe entity correlations', async () => {
  const candidateA: AffectedEntityCandidate = {
    key: entityCandidateKey('workload', 'worker-7d9f', {
      cluster: 'production',
      namespace: 'payments',
    }),
    kind: 'workload',
    stableId: 'worker-7d9f',
    displayName: 'worker-7d9f',
    scope: { cluster: 'production', namespace: 'payments' },
    provenance: { kind: 'provider_label', source: 'pod' },
    confidence: 90,
    observedAt: '2026-08-31T00:00:00.000Z',
    completeness: 'complete',
    requiredCapabilities: ['logs'],
  };
  const candidateB: AffectedEntityCandidate = {
    ...candidateA,
    key: entityCandidateKey('workload', 'worker-b8e1', {
      cluster: 'production',
      namespace: 'payments',
    }),
    stableId: 'worker-b8e1',
    displayName: 'worker-b8e1',
  };
  const context = {
    observations: [{ signalId: 'signal-1', source: null, candidates: [candidateA, candidateB] }],
    mappings: [
      {
        candidateKey: candidateA.key,
        candidateKind: candidateA.kind,
        serviceName: 'payments-api',
        method: 'human' as const,
        confirmedByUserId: 'responder-1',
        rationale: 'Confirmed from the deployment catalog.',
        updatedAt: '2026-08-31T00:01:00.000Z',
      },
      {
        candidateKey: candidateB.key,
        candidateKind: candidateB.kind,
        serviceName: 'payments-worker',
        method: 'catalog_exact' as const,
        confirmedByUserId: null,
        rationale: null,
        updatedAt: '2026-08-31T00:01:00.000Z',
      },
    ],
    services: [],
  };
  mocks.resolveIncidentEntityContext.mockResolvedValue(context);
  const resolveConnectors = vi.fn(async () => [
    {
      id: 'kubernetes-staging',
      name: 'Kubernetes staging',
      type: 'kubernetes' as const,
      entityCoverage: {
        capabilities: ['logs' as const],
        entityKinds: ['workload' as const],
        scope: { cluster: 'staging' },
        assess: () => 'out_of_scope' as const,
      },
    } as unknown as IDataSourceConnector,
  ]);
  const audit = makeInMemoryAuditSink();
  const tool = makeResolveEntityContextTool({ db: {} as Db });

  const result = await runTool(
    tool,
    {
      tenantId: 'tenant-1',
      incidentId: 'incident-1',
      service: 'unclassified',
      resolveConnectors,
      audit,
    },
    {},
  );

  expect(mocks.resolveIncidentEntityContext).toHaveBeenCalledWith(
    expect.anything(),
    'tenant-1',
    'incident-1',
  );
  expect(resolveConnectors).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    available: true,
    data: {
      mappings: [
        expect.objectContaining({ entityRef: 'entity-1', serviceName: 'payments-api' }),
        expect.objectContaining({ entityRef: 'entity-2', serviceName: 'payments-worker' }),
      ],
      services: [],
      observations: [
        expect.objectContaining({
          signalId: 'signal-1',
          candidates: [
            expect.objectContaining({
              entityRef: 'entity-1',
              kind: 'workload',
              stableId: 'worker-7d9f',
            }),
            expect.objectContaining({
              entityRef: 'entity-2',
              kind: 'workload',
              stableId: 'worker-b8e1',
            }),
          ],
        }),
      ],
      capabilityGaps: [
        expect.objectContaining({
          entityRef: 'entity-1',
          capability: 'logs',
          reason: 'scope_mismatch',
          connectors: [expect.objectContaining({ id: 'kubernetes-staging' })],
        }),
        expect.objectContaining({
          entityRef: 'entity-2',
          capability: 'logs',
          reason: 'scope_mismatch',
          connectors: [expect.objectContaining({ id: 'kubernetes-staging' })],
        }),
      ],
    },
  });
  expect(audit.records).toEqual([
    expect.objectContaining({
      tool: 'resolve_entity_context',
      tenantId: 'tenant-1',
      incidentId: 'incident-1',
      outcome: 'data',
      output: expect.objectContaining({
        observations: [
          expect.objectContaining({
            candidates: [
              expect.objectContaining({ entityRef: 'entity-1' }),
              expect.objectContaining({ entityRef: 'entity-2' }),
            ],
          }),
        ],
        mappings: [
          expect.objectContaining({ entityRef: 'entity-1' }),
          expect.objectContaining({ entityRef: 'entity-2' }),
        ],
        capabilityGaps: [
          expect.objectContaining({ entityRef: 'entity-1' }),
          expect.objectContaining({ entityRef: 'entity-2' }),
        ],
      }),
    }),
  ]);
});
