import { describe, expect, it, vi } from 'vitest';
import {
  portForwardCommand,
  restartDelayMs,
  superviseTunnel,
  tunnelSpecs,
  type TunnelSpec,
} from '../index';

const prometheus: TunnelSpec = {
  name: 'prometheus',
  context: 'homelab-v2',
  namespace: 'monitoring',
  service: 'kube-prometheus-stack-prometheus',
  localPort: 9090,
  remotePort: 9090,
};

describe('dev observability tunnels', () => {
  it('uses the homelab Prometheus and Grafana services by default', () => {
    expect(tunnelSpecs({})).toEqual([
      prometheus,
      {
        name: 'grafana',
        context: 'homelab-v2',
        namespace: 'monitoring',
        service: 'kube-prometheus-stack-grafana',
        localPort: 3000,
        remotePort: 80,
      },
    ]);
  });

  it('supports explicit cluster and port overrides, and a full opt-out', () => {
    expect(
      tunnelSpecs({
        DEV_KUBE_CONTEXT: 'other-cluster',
        DEV_PROMETHEUS_LOCAL_PORT: '19090',
        DEV_GRAFANA_LOCAL_PORT: '13000',
      }).map(({ context, localPort }) => ({ context, localPort })),
    ).toEqual([
      { context: 'other-cluster', localPort: 19090 },
      { context: 'other-cluster', localPort: 13000 },
    ]);
    expect(tunnelSpecs({ DEV_OBSERVABILITY_TUNNELS: 'false' })).toEqual([]);
  });

  it('builds a loopback-only service port-forward command', () => {
    expect(portForwardCommand(prometheus)).toEqual([
      'kubectl',
      '--context',
      'homelab-v2',
      '--namespace',
      'monitoring',
      'port-forward',
      '--address=127.0.0.1',
      'service/kube-prometheus-stack-prometheus',
      '9090:9090',
    ]);
  });

  it('caps exponential reconnect delay at thirty seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(restartDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('restarts an exited tunnel and escalates a stuck child on shutdown', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let resolveSecondExit: (code: number) => void = () => {};
    const kills = [
      vi.fn(),
      vi.fn((signal?: number | NodeJS.Signals) => {
        if (signal === 'SIGKILL') resolveSecondExit(137);
      }),
    ];
    let spawnCount = 0;
    try {
      const run = superviseTunnel(prometheus, controller.signal, {
        spawn: () => {
          const index = spawnCount++;
          if (index === 0) return { exited: Promise.resolve(1), kill: kills[index]! };
          return {
            exited: new Promise<number>((resolve) => {
              resolveSecondExit = resolve;
            }),
            kill: kills[index]!,
          };
        },
        sleep: async () => {},
        now: () => 0,
        log: () => {},
      });
      await vi.waitFor(() => expect(spawnCount).toBe(2));
      controller.abort();
      expect(kills[1]).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(kills[1]).toHaveBeenCalledWith('SIGKILL');
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});
