import { describe, expect, test } from 'vitest';
import {
  alertmanagerAffectedEntities,
  service,
  signalObservation,
  type NormalizedAlert,
} from '../alertmanager-webhook/normalize';

const alert = (labels: Record<string, string>): NormalizedAlert => ({
  status: 'firing',
  fingerprint: '0123456789abcdef',
  monitorIdentity: null,
  startsAt: new Date('2026-08-31T00:00:00.000Z'),
  endsAt: null,
  alertName: 'Latency budget exceeded',
  labels: { alertname: 'Latency budget exceeded', ...labels },
  annotations: { summary: 'Latency is above the objective.' },
  generatorUrl: null,
});

describe('Alertmanager affected entities', () => {
  test('never promotes a monitor job or namespace to a service', () => {
    const input = alert({ job: 'metrics-collector', namespace: 'runtime-system' });
    const candidates = alertmanagerAffectedEntities(input, input.startsAt);

    expect(service(input.labels)).toBe('unclassified');
    expect(candidates.some((candidate) => candidate.kind === 'service')).toBe(false);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'namespace',
          stableId: 'runtime-system',
          provenance: { kind: 'provider_label', source: 'namespace' },
        }),
      ]),
    );
  });

  test('uses the first trimmed nonblank service label for routing and entity provenance', () => {
    const input = alert({ service: '   ', app: ' billing-api ', namespace: ' production ' });
    const candidates = alertmanagerAffectedEntities(input, input.startsAt);

    expect(service(input.labels)).toBe('billing-api');
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'service',
          stableId: 'billing-api',
          provenance: { kind: 'provider_label', source: 'app' },
          scope: { namespace: 'production' },
        }),
      ]),
    );
  });

  test('persists the monitor source separately from explicit affected candidates', () => {
    const input = alert({
      service: 'billing-api',
      namespace: 'production',
      pod: 'billing-api-7d9f',
    });
    const observation = signalObservation(
      '00000000-0000-4000-8000-000000000010',
      'group',
      input,
      'hash',
      input.startsAt,
    );

    expect(observation.signalSource).toMatchObject({
      kind: 'monitor',
      provider: 'alertmanager',
      displayName: 'Latency budget exceeded',
    });
    expect(observation.affectedEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'service', stableId: 'billing-api', confidence: 95 }),
        expect.objectContaining({ kind: 'workload', stableId: 'billing-api-7d9f' }),
        expect.objectContaining({ kind: 'namespace', stableId: 'production' }),
      ]),
    );
  });

  test('keeps namespace only where it is part of the affected entity identity', () => {
    const first = alertmanagerAffectedEntities(
      alert({
        cluster: 'production',
        namespace: 'payments-a',
        node: 'worker-01',
        pod: 'checkout-7d9f',
        repository: 'acme/checkout',
      }),
      new Date('2026-08-31T00:00:00.000Z'),
      '00000000-0000-4000-8000-000000000010',
    );
    const second = alertmanagerAffectedEntities(
      alert({
        cluster: 'production',
        namespace: 'payments-b',
        node: 'worker-01',
        pod: 'checkout-7d9f',
        repository: 'acme/checkout',
      }),
      new Date('2026-08-31T00:01:00.000Z'),
      '00000000-0000-4000-8000-000000000010',
    );
    const key = (items: ReturnType<typeof alertmanagerAffectedEntities>, kind: string) =>
      items.find((candidate) => candidate.kind === kind)!.key;

    expect(key(first, 'node')).toBe(key(second, 'node'));
    expect(key(first, 'repository')).toBe(key(second, 'repository'));
    expect(key(first, 'workload')).not.toBe(key(second, 'workload'));
    expect(first.find((candidate) => candidate.kind === 'node')?.scope).toEqual({
      dataSourceId: '00000000-0000-4000-8000-000000000010',
      cluster: 'production',
    });
  });
});
