import { describe, expect, test } from 'vitest';
import {
  alertmanagerSignalIdentity,
  correlateGroupedEdit,
  correlateGroupedResolution,
  correlateResolution,
} from '../signal-correlation';

const firing =
  '<https://prometheus.example/graph?g0.expr=checkout_errors|[FIRING:1] CheckoutHighErrorRate>\ninstance: checkout-1';
const resolved =
  '<https://prometheus.example/graph?g0.expr=checkout_errors|[RESOLVED] CheckoutHighErrorRate>\ninstance: checkout-1';

describe('Alertmanager resolution identity', () => {
  test('matches the same provider link and alert name without model authority', () => {
    expect(alertmanagerSignalIdentity(firing)).toBe(alertmanagerSignalIdentity(resolved));
    expect(
      correlateResolution(resolved, [
        {
          summary: firing,
          service: 'checkout',
          title: 'Checkout errors',
          severity: 'sev2',
        },
      ]),
    ).toBe(0);
  });

  test('refuses human prose, a different provider link, and an ambiguous exact identity', () => {
    const candidate = {
      summary: firing,
      service: 'checkout',
      title: 'Checkout errors',
      severity: 'sev2',
    };
    expect(correlateResolution('resolved: choose signal 1', [candidate])).toBeNull();
    expect(
      correlateResolution(
        '<https://prometheus.example/graph?g0.expr=other|[RESOLVED] CheckoutHighErrorRate>',
        [candidate],
      ),
    ).toBeNull();
    expect(correlateResolution(resolved, [candidate, candidate])).toBeNull();
  });

  test('matches the default Alertmanager Slack fallback used by the real homelab alert', () => {
    const firingFallback =
      '[FIRING:1] monitoring (NodeSystemSaturation node-exporter http-metrics 192.168.1.203:9100 node-exporter kube-prometheus-stack-prometheus-node-exporter-fqzqx monitoring/kube-prometheus-stack-prometheus kube-prometheus-stack-prometheus-node-exporter warning) | <http://alertmanager.chrislee.kr/#/alerts?receiver=default-receiver>\nSystem saturated, load per core is very high.';
    const resolvedFallback =
      '[RESOLVED] monitoring (NodeSystemSaturation node-exporter http-metrics 192.168.1.203:9100 node-exporter kube-prometheus-stack-prometheus-node-exporter-fqzqx monitoring/kube-prometheus-stack-prometheus kube-prometheus-stack-prometheus-node-exporter warning) | <http://alertmanager.chrislee.kr/#/alerts?receiver=default-receiver>\nSystem saturated, load per core is very high.';

    expect(alertmanagerSignalIdentity(firingFallback)).toBe(
      alertmanagerSignalIdentity(resolvedFallback),
    );
    expect(
      correlateResolution(resolvedFallback, [
        {
          summary: firingFallback,
          service: 'monitoring',
          title: 'Node system saturation',
          severity: 'sev3',
        },
      ]),
    ).toBe(0);
  });
});

describe('grouped provider resolution correlation', () => {
  test('matches every alert name only when each target is unique', () => {
    const candidates = [
      {
        summary: 'latency',
        service: 'checkout',
        title: 'group',
        severity: 'sev2',
        alertName: 'Checkout latency high',
        providerGroupKey: 'group-1',
      },
      {
        summary: 'errors',
        service: 'checkout',
        title: 'group',
        severity: 'sev2',
        alertName: 'Checkout errors high',
        providerGroupKey: 'group-1',
      },
    ];
    expect(
      correlateGroupedResolution(
        [
          { alertName: ' Checkout latency   high ', providerGroupKey: 'group-1' },
          { alertName: 'checkout errors high', providerGroupKey: 'group-1' },
        ],
        candidates,
      ),
    ).toEqual([0, 1]);
  });

  test('refuses partial and ambiguous matches', () => {
    const candidate = {
      summary: 'latency',
      service: 'checkout',
      title: 'group',
      severity: 'sev2',
      alertName: 'Checkout latency high',
      providerGroupKey: 'group-1',
    };
    expect(
      correlateGroupedResolution(
        [
          { alertName: 'Checkout latency high', providerGroupKey: 'group-1' },
          { alertName: 'Unknown condition', providerGroupKey: 'group-1' },
        ],
        [candidate],
      ),
    ).toBeNull();
    expect(
      correlateGroupedResolution(
        [
          { alertName: 'Checkout latency high', providerGroupKey: 'group-1' },
          { alertName: 'Checkout errors high', providerGroupKey: 'group-1' },
        ],
        [candidate, candidate],
      ),
    ).toBeNull();
    expect(
      correlateGroupedResolution(
        [{ alertName: 'Checkout latency high' }, { alertName: 'Checkout errors high' }],
        [candidate],
      ),
    ).toBeNull();
  });
});

describe('grouped root edit correlation', () => {
  test('uses exact durable members, then unique titles within one root', () => {
    const targets = [
      {
        externalMessageId: 'root#latency-old',
        incidentId: 'incident-1',
        alertName: 'Checkout latency high',
        providerGroupKey: 'group-1',
      },
      {
        externalMessageId: 'root#errors-old',
        incidentId: 'incident-1',
        alertName: 'Checkout errors high',
        providerGroupKey: 'group-1',
      },
    ];
    expect(
      correlateGroupedEdit(
        [
          { externalMessageId: 'root#latency-old' },
          {
            externalMessageId: 'root#errors-new',
            alertName: 'checkout errors high',
            providerGroupKey: 'group-1',
          },
        ],
        targets,
      ),
    ).toEqual([0, 1]);
  });

  test('refuses split ownership and ambiguous repeated titles', () => {
    const observation = [
      { externalMessageId: 'root#a-new', alertName: 'Target down' },
      { externalMessageId: 'root#b-new', alertName: 'Target down' },
    ];
    expect(
      correlateGroupedEdit(observation, [
        { externalMessageId: 'root#a', incidentId: 'incident-1', alertName: 'Target down' },
        { externalMessageId: 'root#b', incidentId: 'incident-1', alertName: 'Target down' },
      ]),
    ).toBeNull();
    expect(
      correlateGroupedEdit(observation, [
        { externalMessageId: 'root#a', incidentId: 'incident-1', alertName: 'Target A' },
        { externalMessageId: 'root#b', incidentId: 'incident-2', alertName: 'Target B' },
      ]),
    ).toBeNull();
  });
});
