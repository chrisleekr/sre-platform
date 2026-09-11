import { describe, expect, test } from 'vitest';
import type { NormalizedSnapshot } from '../types';
// The two byte-identical deploy decoders (apps/api snapshots.ts and apps/triage-worker
// persist-deploys.ts) are collapsed into ONE shared decoder, homed here in packages/connectors (which
// owns NormalizedSnapshot). These assertions pin its unified fallback contract.
import { coerceDeployStatus, decodeDeploySnapshot, DEPLOY_STATUSES } from '../deploy-decode';

function snap(over: Partial<NormalizedSnapshot> = {}): NormalizedSnapshot {
  const { metadata, ...rest } = over;
  return {
    tenantId: 't1',
    source: 'gitlab',
    entityId: 'p1',
    metrics: {},
    observedAt: new Date('2026-07-01T00:05:00Z'),
    ...rest,
    metadata: { repo: '71', ref: 'main', sha: 'deadbeef', ...metadata },
  };
}

describe('decodeDeploySnapshot (shared decoder)', () => {
  test('missing status falls back to "pending" (never empty)', () => {
    const d = decodeDeploySnapshot(snap({ metadata: { repo: '71', sha: 'x' } }));
    expect(d.status).toBe('pending');
  });

  test('present status passes through', () => {
    const d = decodeDeploySnapshot(snap({ metadata: { repo: '71', sha: 'x', status: 'failed' } }));
    expect(d.status).toBe('failed');
  });

  test('preserves GitHub transient environment as a separate boolean', () => {
    const d = decodeDeploySnapshot(
      snap({ metadata: { repo: '71', sha: 'x', transientEnvironment: true } }),
    );
    expect(d.transientEnvironment).toBe(true);
    expect(d.status).toBe('pending');
  });

  test('preserves ordered ArgoCD revisions and operation phase', () => {
    const decoded = decodeDeploySnapshot(
      snap({
        source: 'argocd',
        metadata: {
          repo: 'payments/argocd/checkout',
          sha: 'release-app',
          revisions: ['release-app', 'release-config'],
          operationPhase: 'Succeeded',
        },
      }),
    );
    expect(decoded).toMatchObject({
      revisions: ['release-app', 'release-config'],
      operationPhase: 'Succeeded',
    });
  });

  test('deployedAt uses the metadata timestamp when valid', () => {
    const d = decodeDeploySnapshot(
      snap({ metadata: { repo: '71', sha: 'x', deployedAt: '2026-07-01T00:05:00Z' } }),
    );
    expect(d.deployedAt).toBe('2026-07-01T00:05:00.000Z');
  });

  test('deployedAt falls back to observedAt when the metadata timestamp is absent/invalid', () => {
    const d = decodeDeploySnapshot(
      snap({
        metadata: { repo: '71', sha: 'x', deployedAt: 'not-a-date' },
        observedAt: new Date('2026-07-02T09:00:00Z'),
      }),
    );
    expect(d.deployedAt).toBe('2026-07-02T09:00:00.000Z');
  });

  test('url is undefined when metadata carries none', () => {
    const d = decodeDeploySnapshot(snap({ metadata: { repo: '71', sha: 'x' } }));
    expect(d.url).toBeUndefined();
  });

  // [RED]: a connector status outside the DeployStatus union used to pass through decode raw and
  // reach the dashboard, where STATUS_BADGE[status] is undefined. decode now coerces at the boundary.
  test('preserves GitHub failure as a canonical operational status', () => {
    const d = decodeDeploySnapshot(snap({ metadata: { repo: '71', sha: 'x', status: 'failure' } }));
    expect(d.status).toBe('failure');
  });
});

// the single point that maps a free-text connector status onto the client DeployStatus union
// Anything unrecognised is 'pending' so a raw provider token never reaches the dashboard badge map.
describe('coerceDeployStatus', () => {
  test('DEPLOY_STATUSES is exactly the client DeployStatus union', () => {
    expect([...DEPLOY_STATUSES].sort()).toEqual(
      [
        'blocked',
        'canceled',
        'error',
        'failed',
        'failure',
        'inactive',
        'pending',
        'running',
        'success',
      ].sort(),
    );
  });

  test('each union member passes through unchanged', () => {
    for (const s of DEPLOY_STATUSES) {
      expect(coerceDeployStatus(s)).toBe(s);
    }
  });

  test('maps known connector aliases onto the union', () => {
    const cases: Array<[string, string]> = [
      ['failure', 'failure'],
      ['error', 'error'],
      ['timed_out', 'failed'], // GitHub Actions terminal-failure conclusion
      ['startup_failure', 'failed'], // GitHub Actions terminal-failure conclusion
      ['cancelled', 'canceled'],
      ['in_progress', 'running'],
      ['created', 'pending'],
      ['queued', 'pending'],
      ['manual', 'pending'],
      ['scheduled', 'pending'],
      ['waiting_for_resource', 'pending'],
      ['blocked', 'blocked'],
      ['inactive', 'inactive'],
    ];
    for (const [raw, want] of cases) {
      expect(coerceDeployStatus(raw)).toBe(want);
    }
  });

  test('an unrecognised status falls back to "pending"', () => {
    expect(coerceDeployStatus('skipped')).toBe('pending');
    expect(coerceDeployStatus('whatever')).toBe('pending');
  });

  test('undefined and empty fall back to "pending"', () => {
    expect(coerceDeployStatus(undefined)).toBe('pending');
    expect(coerceDeployStatus('')).toBe('pending');
  });
});
