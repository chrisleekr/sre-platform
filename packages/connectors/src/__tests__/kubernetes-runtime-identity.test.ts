import { expect, test } from 'vitest';
import { podSnapshot } from '../data-sources/kubernetes/runtime';

test.each([
  ['Running', true, {}, 'healthy'],
  ['Running', false, { waiting: { reason: 'CrashLoopBackOff' } }, 'attention'],
  ['Failed', false, { terminated: { reason: 'OOMKilled' } }, 'attention'],
  ['Succeeded', false, { terminated: { reason: 'Completed' } }, 'healthy'],
])(
  'publishes exact UID identity and %s state without confusing completed jobs with failures',
  (phase, ready, state, expected) => {
    const snapshot = podSnapshot(
      'tenant',
      undefined,
      {
        metadata: { name: 'job-or-service', namespace: 'apps', uid: 'immutable-pod-id' },
        status: { phase, containerStatuses: [{ name: 'main', ready, state }] },
      },
      new Date(),
    );
    expect(snapshot.topology).toEqual({
      ref: {
        authority: 'kubernetes-object',
        kind: 'Pod',
        id: JSON.stringify(['apps', 'immutable-pod-id']),
      },
      state: expected,
    });
  },
);

test('does not substitute pod names for missing immutable identity', () => {
  expect(
    podSnapshot('tenant', 'apps', { metadata: { name: 'pod' }, status: {} }, new Date()).topology,
  ).toBeUndefined();
});
