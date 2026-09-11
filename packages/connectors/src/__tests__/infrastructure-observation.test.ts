import { describe, expect, test } from 'vitest';
import type { NormalizedSnapshot } from '../types';
import {
  normalizeConnectorVerificationObservation,
  normalizeInfrastructureObservation,
  normalizeTopologyServiceObservation,
} from '../subject-observations';

function snapshot(overrides: Partial<NormalizedSnapshot> = {}): NormalizedSnapshot {
  return {
    tenantId: '00000000-0000-4000-8000-000000000281',
    source: 'kubernetes',
    entityId: 'monitoring/prometheus-0',
    metrics: { ready: 1, restartCount: 1, oomKilled: 1 },
    metadata: {
      kind: 'pod',
      namespace: 'monitoring',
      phase: 'Running',
      pressures: ['MemoryPressure'],
      containers: [
        {
          name: 'prometheus',
          ready: true,
          restartCount: 1,
          terminatedReason: 'OOMKilled',
        },
      ],
    },
    observedAt: new Date('2026-08-28T01:00:00.000Z'),
    ...overrides,
  };
}

describe('normalizeInfrastructureObservation', () => {
  test('produces identical material when only the observation time changes', () => {
    const first = normalizeInfrastructureObservation(
      snapshot(),
      new Date('2026-08-28T01:00:20.000Z'),
    );
    const deferred = normalizeInfrastructureObservation(
      snapshot({ observedAt: new Date('2026-08-28T01:00:10.000Z') }),
      new Date('2026-08-28T01:00:30.000Z'),
    );

    expect(deferred).toMatchObject({
      state: first.state,
      summary: first.summary,
      snapshot: first.snapshot,
      contentHash: first.contentHash,
    });
    expect(deferred.observedAt).not.toEqual(first.observedAt);
    expect(first.summary).toBe('1 OOM-killed container · 1 restart · OOMKilled · MemoryPressure');
  });

  test('changes the material hash when a diagnostic value changes', () => {
    const now = new Date('2026-08-28T01:00:20.000Z');
    const first = normalizeInfrastructureObservation(snapshot(), now);
    const changed = normalizeInfrastructureObservation(
      snapshot({ metrics: { ready: 1, restartCount: 2, oomKilled: 1 } }),
      now,
    );

    expect(changed.contentHash).not.toBe(first.contentHash);
    expect(changed.summary).toContain('2 restarts');
  });

  test('preserves a prior termination as resolved diagnostic history', () => {
    const recovered = normalizeInfrastructureObservation(
      snapshot({
        metrics: { ready: 1, restartCount: 1, oomKilled: 0 },
        metadata: {
          kind: 'pod',
          namespace: 'monitoring',
          phase: 'Running',
          containers: [
            {
              name: 'prometheus',
              ready: true,
              restartCount: 1,
              lastTerminatedReason: 'OOMKilled',
              lastTerminatedAt: '2026-08-17T05:43:23Z',
            },
          ],
        },
      }),
      new Date('2026-08-28T01:00:20.000Z'),
    );

    expect(recovered).toMatchObject({
      state: 'resolved',
      summary: 'Resource is healthy',
      snapshot: {
        containers: [
          expect.objectContaining({
            lastTerminatedReason: 'OOMKilled',
            lastTerminatedAt: '2026-08-17T05:43:23Z',
          }),
        ],
      },
    });
  });

  test('bounds provider arrays and diagnostic reasons', () => {
    const bounded = normalizeInfrastructureObservation(
      snapshot({
        metadata: {
          kind: 'pod',
          namespace: 'monitoring',
          phase: 'Running',
          pressures: Array.from({ length: 50 }, (_, index) => `Pressure${index}`),
          containers: Array.from({ length: 30 }, (_, index) => ({
            name: `container-${index}`,
            ready: false,
            waitingReason: `Waiting${index}`,
            terminatedReason: `Terminated${index}`,
          })),
        },
      }),
      new Date('2026-08-28T01:00:20.000Z'),
    );

    expect(bounded.snapshot.pressures).toHaveLength(20);
    expect(bounded.snapshot.containers).toHaveLength(10);
    expect(bounded.summary.length).toBeLessThanOrEqual(2_000);
    expect(bounded.summary.split(' · ').length).toBeLessThanOrEqual(40);
  });

  test('canonicalizes set-like pressure and container arrays before hashing', () => {
    const now = new Date('2026-08-28T01:00:20.000Z');
    const first = snapshot({
      metadata: {
        kind: 'pod',
        namespace: 'monitoring',
        phase: 'Running',
        pressures: ['MemoryPressure', 'DiskPressure'],
        containers: [
          { name: 'sidecar', ready: true, restartCount: 0 },
          { name: 'prometheus', ready: true, restartCount: 1, terminatedReason: 'OOMKilled' },
        ],
      },
    });
    const reversed = {
      ...first,
      metadata: {
        ...first.metadata,
        pressures: [...(first.metadata.pressures as string[])].reverse(),
        containers: [...(first.metadata.containers as unknown[])].reverse(),
      },
    };

    const canonical = normalizeInfrastructureObservation(first, now);
    const reordered = normalizeInfrastructureObservation(reversed, now);

    expect(reordered.snapshot).toEqual(canonical.snapshot);
    expect(reordered.contentHash).toBe(canonical.contentHash);
  });
});

describe('normalizeConnectorVerificationObservation', () => {
  const failed = {
    connectorType: 'kubernetes',
    connectorName: 'Primary cluster',
    enabled: false,
    failureCategory: 'permission_denied',
    attemptedAt: new Date('2026-08-28T01:00:00.000Z'),
    succeededAt: null,
  };

  test('keeps unchanged verification material stable and represents recovery', () => {
    const initial = normalizeConnectorVerificationObservation(
      failed,
      new Date('2026-08-28T01:00:01.000Z'),
    );
    const deferred = normalizeConnectorVerificationObservation(
      failed,
      new Date('2026-08-28T01:05:00.000Z'),
    );
    const recovered = normalizeConnectorVerificationObservation(
      { ...failed, succeededAt: new Date('2026-08-28T01:06:00.000Z') },
      new Date('2026-08-28T01:06:01.000Z'),
    );

    expect(deferred.contentHash).toBe(initial.contentHash);
    expect(recovered.state).toBe('resolved');
    expect(recovered.contentHash).not.toBe(initial.contentHash);
  });

  test('uses the timestamp for the state it reports', () => {
    const priorSuccess = new Date('2026-08-28T00:55:00.000Z');
    const laterFailure = new Date('2026-08-28T01:00:00.000Z');
    const firing = normalizeConnectorVerificationObservation(
      { ...failed, attemptedAt: laterFailure, succeededAt: priorSuccess },
      new Date('2026-08-28T01:01:00.000Z'),
    );
    const resolvedAt = new Date('2026-08-28T01:02:00.000Z');
    const resolved = normalizeConnectorVerificationObservation(
      { ...failed, attemptedAt: laterFailure, succeededAt: resolvedAt },
      new Date('2026-08-28T01:03:00.000Z'),
    );

    expect(firing).toMatchObject({ state: 'firing', observedAt: laterFailure });
    expect(resolved).toMatchObject({ state: 'resolved', observedAt: resolvedAt });
  });
});

describe('normalizeTopologyServiceObservation', () => {
  test('classifies stale-only runtime as unknown and tracks material recovery', () => {
    const stale = snapshot({
      metrics: { ready: 1, restartCount: 0, oomKilled: 0 },
      metadata: { kind: 'pod', namespace: 'monitoring', phase: 'Running' },
      observedAt: new Date('2026-08-28T00:55:00.000Z'),
    });
    const unknown = normalizeTopologyServiceObservation(
      { service: 'monitoring', team: 'platform', criticality: 'tier1', snapshots: [stale] },
      new Date('2026-08-28T01:00:00.000Z'),
    );
    const recovered = normalizeTopologyServiceObservation(
      {
        service: 'monitoring',
        team: 'platform',
        criticality: 'tier1',
        snapshots: [{ ...stale, observedAt: new Date('2026-08-28T01:00:00.000Z') }],
      },
      new Date('2026-08-28T01:00:10.000Z'),
    );

    expect(unknown.state).toBe('unknown');
    expect(unknown.summary).toContain('stale or unknown');
    expect(recovered.state).toBe('resolved');
    expect(recovered.contentHash).not.toBe(unknown.contentHash);
  });

  test('hashes identical multi-pod runtime independently of provider ordering', () => {
    const now = new Date('2026-08-28T01:00:20.000Z');
    const first = snapshot({ entityId: 'monitoring/prometheus-0' });
    const second = snapshot({
      entityId: 'monitoring/prometheus-1',
      metrics: { ready: 0, restartCount: 2, oomKilled: 0 },
      metadata: { kind: 'pod', namespace: 'monitoring', phase: 'Pending' },
    });
    const input = { service: 'monitoring', team: 'platform', criticality: 'tier1' };

    const ordered = normalizeTopologyServiceObservation(
      { ...input, snapshots: [first, second] },
      now,
    );
    const reversed = normalizeTopologyServiceObservation(
      { ...input, snapshots: [second, first] },
      now,
    );

    expect(reversed.snapshot).toEqual(ordered.snapshot);
    expect(reversed.contentHash).toBe(ordered.contentHash);
  });
});
